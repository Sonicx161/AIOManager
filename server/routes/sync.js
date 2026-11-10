import crypto from 'crypto'
import db from '../db.js'
import { encrypt, decrypt } from '../crypto.js'
import { PRIMARY_KEY, FALLBACK_KEYS } from '../keys.js'
import { getCachedAuth, getCachedAuthBound, setCachedAuth, invalidateCachedAuth, hashAuthPassword } from '../state.js'
import { timingSafeEqual } from '../auth.js'
import { hashApiKey } from '../api-keys.js'
import { writeEncryptedIfChanged } from '../db-guards.js'
import { invalidateCanonicalAddons } from './hydra.js'
import { listStremioCredentialedAccountIds } from '../lib/stremio-credentials.js'
import { hashSyncPassword, isScryptHash, verifySyncPassword, upgradeLegacyPasswordHash, prepareLegacyPasswordUpgrade, applyLegacyPasswordUpgrade } from '../lib/sync-password.js'
import { isRegistrationsClosed } from '../config.js'
import { assertAccountActive, assertWritablePrimary, refreshAccountAdminState } from '../admin/account-state.js'
import { invalidateSyncResponseCache, getSyncResponseCache, setSyncResponseCache, syncResponseCacheStats } from '../lib/sync-response-cache.js'
import { noteSyncWrite } from '../lib/wal-checkpoint.js'
import { trace } from '../utils/trace.js'
import { maskContext } from '../utils/log-helpers.js'

function buildMultiRowPlaceholders(numRows, numCols) {
    const rows = []
    let p = 1
    for (let r = 0; r < numRows; r++) {
        const cols = []
        for (let c = 0; c < numCols; c++) {
            cols.push(`$${p++}`)
        }
        rows.push(`(${cols.join(', ')})`)
    }
    return rows.join(', ')
}

const KV_HISTORY_KEEP = 3

async function registerApiKeys(tx, id, apiKeys, pushedAccounts) {
    const existingKeyAccounts = new Set(
        (await tx.query('SELECT DISTINCT account_id FROM account_api_keys WHERE sync_user = $1', [id])).map(r => r.account_id),
    )
    if (pushedAccounts) {
        const presentIds = new Set(pushedAccounts.map(a => a && a.id).filter(Boolean))
        const retained = [...existingKeyAccounts].filter(accId => presentIds.has(accId) && !(accId in apiKeys))
        if (retained.length > 0) {
            const retainedParams = [id, ...retained]
            await tx.run(
                `DELETE FROM account_api_keys WHERE sync_user = $1 AND account_id NOT IN (${retained.map((_, i) => `$${i + 2}`).join(',')})`,
                retainedParams,
            )
        } else {
            await tx.run('DELETE FROM account_api_keys WHERE sync_user = $1', [id])
        }
    } else {
        await tx.run('DELETE FROM account_api_keys WHERE sync_user = $1', [id])
    }
    const apiKeyRows = []
    const seenHashes = new Map()
    for (const [accountId, apiKey] of Object.entries(apiKeys)) {
        if (typeof apiKey !== 'string' || !apiKey) continue
        const h = hashApiKey(apiKey)
        const existing = seenHashes.get(h)
        if (existing !== undefined) apiKeyRows[existing] = null
        seenHashes.set(h, apiKeyRows.length)
        apiKeyRows.push([accountId, id, h, Date.now()])
    }
    const dedupedRows = apiKeyRows.filter(Boolean)
    const API_KEY_CHUNK = 100
    for (let i = 0; i < dedupedRows.length; i += API_KEY_CHUNK) {
        const chunk = dedupedRows.slice(i, i + API_KEY_CHUNK)
        if (chunk.length === 0) continue
        const placeholders = buildMultiRowPlaceholders(chunk.length, 4)
        const params = chunk.flat()
        const sql = `INSERT INTO account_api_keys (account_id, sync_user, api_key_hash, created_at) VALUES ${placeholders}`
        await tx.run(sql, params)
    }
}

async function archiveCurrentKV(tx, key, authUser) {
    try {
        const now = Date.now()
        await tx.run(
            `INSERT INTO kv_store_history (key, value, password, updated_at, content_hash, archived_at)
             SELECT key, value, password, updated_at, content_hash, $1 FROM kv_store WHERE key = $2`,
            [now, key]
        )
        await tx.run(
            `DELETE FROM kv_store_history WHERE key = $1 AND archived_at NOT IN (
                 SELECT archived_at FROM kv_store_history WHERE key = $2 ORDER BY archived_at DESC LIMIT $3
             )`,
            [key, key, KV_HISTORY_KEEP]
        )
        trace('syncRoute', 'kv.archived', { accountId: key, by: authUser || 'system' })
    } catch (err) {
        trace('syncRoute', 'kv.archive.failed', { accountId: key, error: err && err.message })
    }
}

/**
 * Structural JSON equality for the skip path: object key order is ignored (a
 * stored list written by another writer may serialize the same content with
 * different key order or spacing), array order is significant, and primitive
 * values must match exactly. Operates on parsed JSON only.
 */
function jsonStructurallyEqual(a, b) {
    if (a === b) return true
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
        return a.every((item, i) => jsonStructurallyEqual(item, b[i]))
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
        const keys = Object.keys(a)
        if (keys.length !== Object.keys(b).length) return false
        return keys.every(k => Object.prototype.hasOwnProperty.call(b, k) && jsonStructurallyEqual(a[k], b[k]))
    }
    return false
}

// A hub whose stored list differs from a re-pushed snapshot is rejected on every
// byte-identical skip, and a stuck client re-pushes the same envelope forever:
// warn on the first mismatch per hub per process, then drop to debug. The trace
// event stays on every occurrence.
const skipMismatchWarned = new Set()
const SKIP_MISMATCH_WARNED_MAX = 5000

/**
 * Receipts for a byte-identical re-push (the skip path). The first attempt may
 * have committed on the server while its response was lost, so an empty receipt
 * map would strand the caller's merge base for entries that DID land. Verify
 * each submitted entry against the workspace-scoped store: 'unchanged' only for
 * structurally equal parsed JSON (object key order ignored, array order and
 * primitives exact), 'rejected' otherwise. Never claims or writes rows, and
 * never rewrites a stored row whose bytes merely differ in serialization.
 */
async function skipPathCanonicalReceipts(tx, id, canonicalAddons, log) {
    const receipts = {}
    const reasons = {}
    if (!canonicalAddons || typeof canonicalAddons !== 'object') return { receipts, reasons }
    const submitted = Object.entries(canonicalAddons).filter(([accountId, addons]) => accountId && Array.isArray(addons))
    const stored = new Map()
    const CHUNK = 100
    for (let i = 0; i < submitted.length; i += CHUNK) {
        const ids = submitted.slice(i, i + CHUNK).map(([accountId]) => accountId)
        const inList = ids.map((_, j) => `$${j + 2}`).join(', ')
        const rows = await tx.query(
            `SELECT account_id, addon_list FROM account_canonical_addons WHERE sync_user = $1 AND account_id IN (${inList})`,
            [id, ...ids],
        )
        for (const r of rows) stored.set(r.account_id, r.addon_list)
    }
    for (const [accountId, addons] of submitted) {
        const encrypted = stored.get(accountId)
        let verified = false
        if (encrypted) {
            // Compare parsed JSON structurally, not bytes: another writer may have
            // stored the same list with a different object-key order or spacing, and
            // a byte check would reject that hub on every skip forever while the
            // skip path keeps being chosen. The stored row itself is never rewritten.
            try {
                verified = jsonStructurallyEqual(JSON.parse(decrypt(encrypted, FALLBACK_KEYS)), addons)
            } catch {}
        }
        if (verified) {
            receipts[accountId] = 'unchanged'
        } else {
            // Rejected rather than omitted: the push's snapshot is not what the
            // server holds, and an omitted entry is indistinguishable from a
            // receipt-less older server once mixed with confirmed ones.
            receipts[accountId] = 'rejected'
            reasons[accountId] = 'not-applied'
            const firstMismatch = !skipMismatchWarned.has(accountId)
            if (firstMismatch) {
                if (skipMismatchWarned.size >= SKIP_MISMATCH_WARNED_MAX) skipMismatchWarned.delete(skipMismatchWarned.values().next().value)
                skipMismatchWarned.add(accountId)
            }
            const fields = { category: 'Sync', fmt: 'sync.canonical_skip', acct: accountId, reason: 'skip-mismatch' }
            const text = `Canonical skip check: stored list for ${maskContext(accountId)} differs from the resubmitted snapshot.`
            if (firstMismatch) log.warn(fields, text)
            else log.debug({ ...fields, repeat: true }, text)
            trace('syncRoute', 'canonical.skip_mismatch', { accountId: id, hub: maskContext(accountId) })
        }
    }
    return { receipts, reasons }
}

export function registerSyncRoutes(fastify) {
    fastify.get('/api/sync/:id', {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        schema: {
            params: {
                type: 'object',
                properties: {
                    id: { type: 'string' }
                }
            },
            response: {
                200: {
                    type: 'object',
                    additionalProperties: true
                }
            }
        }
    }, async (request, reply) => {
        // Account state gate: first statement, outside the try below, before any read.
        await assertAccountActive(request.params.id)
        const { id } = request.params
        const password = request.headers['x-sync-password']
        const start = Date.now()
        trace('syncRoute', 'pull.start', { accountId: id })

        if (!id || !password) {
            trace('syncRoute', 'pull.error', { accountId: id, error: 'missing-credentials' })
            reply.status(400);
            return { error: 'Missing ID or Password header' }
        }

        try {
            // A conditional refresh only needs the encrypted blob when its revision changed.
            // Keep password and revision in the same read; authentication still precedes 304.
            const row = await db.get(
                'SELECT CASE WHEN content_hash = $1 THEN NULL ELSE value END AS value, password, content_hash FROM kv_store WHERE key = $2',
                [request.headers['if-none-match'] || null, id]
            )

            if (!row) {
                trace('syncRoute', 'pull.error', { accountId: id, error: 'not-found' })
                reply.status(401);
                return { error: 'Unauthorized: Invalid credentials' }
            }

            const cachedPw = request.deviceAuth?.accountUuid === id ? null : getCachedAuth('sync:' + id)
            if (cachedPw && timingSafeEqual(cachedPw, hashAuthPassword(password))) {
            } else if (request.deviceAuth?.accountUuid !== id) {
                const verified = await verifySyncPassword(password, row.password)
                let authorized = verified === true
                if (verified === null) {
                    const decryptedPassword = decrypt(row.password, FALLBACK_KEYS)
                    authorized = !!decryptedPassword && timingSafeEqual(decryptedPassword, password)
                }
                if (!authorized) {
                    fastify.log.warn({ category: 'Sync', fmt: 'sync.auth_rejected', acct: id }, `[${maskContext(id)}] Unauthorized: Password mismatch.`)
                    trace('syncRoute', 'pull.error', { accountId: id, error: 'password-mismatch' })
                    reply.status(401);
                    return { error: 'Unauthorized: Invalid credentials' }
                }
                setCachedAuth('sync:' + id, password, row.password)
            }

            if (row.content_hash && request.headers['if-none-match'] === row.content_hash) {
                trace('syncRoute', 'pull.not_modified', { accountId: id, timing: Date.now() - start })
                reply.status(304)
                reply.header('ETag', row.content_hash)
                return reply.send()
            }

            // Response cache: content_hash exactly identifies the stored blob, so a
            // hit can serve the previously serialized (already canonicalAddons-stripped)
            // bytes without decrypt/parse. Auth above already gated this request.
            const cachedResponse = row.content_hash ? getSyncResponseCache(id, row.content_hash) : null
            if (cachedResponse) {
                trace('syncRoute', 'pull.success', { accountId: id, bytes: cachedResponse.bytes, cache: 'hit', cacheStats: syncResponseCacheStats(), timing: Date.now() - start })
                reply.header('ETag', row.content_hash)
                reply.header('content-type', 'application/json; charset=utf-8')
                return reply.send(cachedResponse.serialized)
            }

            const decryptedValueStr = decrypt(row.value, FALLBACK_KEYS)
            const needsMigration = (row.password && typeof row.password === 'string' && !isScryptHash(row.password)) ||
                (row.value && typeof row.value === 'string' && !row.value.includes(':'))

            if (needsMigration) {
                fastify.log.info({ category: 'Sync', fmt: 'sync.zk_upgrade', acct: id, ms: Date.now() - start }, `[${maskContext(id)}] Upgrading sync data to Zero-Knowledge storage.`)
                // Device-authed requests carry a token in x-sync-password; it must never become the stored account password.
                const storedPass = request.deviceAuth
                    ? row.password
                    : (isScryptHash(row.password) ? row.password : await hashSyncPassword(password))
                const encryptedVal = encrypt(decryptedValueStr, PRIMARY_KEY)
                db.run('UPDATE kv_store SET password = $1, value = $2, updated_at = $3 WHERE key = $4',
                    [storedPass, encryptedVal, Date.now(), id]).catch(err => {
                        fastify.log.error({ category: 'Sync' }, `[${maskContext(id)}] Migration write failed: ${err.message}`)
                    })
            }

            let syncData = {}
            if (decryptedValueStr) {
                try {
                    syncData = typeof decryptedValueStr === 'string' ? JSON.parse(decryptedValueStr) : decryptedValueStr
                } catch (e) {
                    fastify.log.warn({ category: 'Sync' }, `[${maskContext(id)}] Failed to parse sync data: ${e.message}`)
                    syncData = {}
                }
            }
            const payloadBytes = decryptedValueStr ? decryptedValueStr.length : 0
            // Omit push-only canonical metadata while preserving legacy payload shapes.
            if (syncData && typeof syncData === 'object' && !Array.isArray(syncData)) {
                delete syncData.canonicalAddons
            }
            if (syncData && typeof syncData === 'object' && !Array.isArray(syncData) && row.content_hash) {
                // Serialize once with the route's own serializer; a later hit returns
                // these exact bytes (probe-verified identical to the object path).
                const serialized = reply.serialize(syncData)
                setSyncResponseCache(id, row.content_hash, serialized)
                trace('syncRoute', 'pull.success', { accountId: id, bytes: payloadBytes, cache: 'miss', cacheStats: syncResponseCacheStats(), timing: Date.now() - start })
                if (row.content_hash) reply.header('ETag', row.content_hash)
                reply.header('content-type', 'application/json; charset=utf-8')
                return reply.send(serialized)
            }
            trace('syncRoute', 'pull.success', { accountId: id, bytes: payloadBytes, cache: 'bypass', timing: Date.now() - start })
            if (row.content_hash) reply.header('ETag', row.content_hash)
            return syncData && typeof syncData === 'object' ? syncData : {}
        } catch (err) {
            fastify.log.error({ category: 'Sync', fmt: 'sync.error', op: 'pull', acct: id, err }, `[${maskContext(id)}] GET Error: ${err.message}`)
            trace('syncRoute', 'pull.error', { accountId: id, error: err.message, timing: Date.now() - start })
            reply.status(500);
            return { error: 'Server error, please try again later.' }
        }
    })

    fastify.post('/api/sync/:id', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
        schema: {
            params: {
                type: 'object',
                properties: { id: { type: 'string' } }
            },
            body: {
                type: 'object',
                additionalProperties: true
            }
        }
    }, async (request, reply) => {
        const postStart = Date.now()
        // Account state gate ahead of the transaction; outside the try below.
        await assertAccountActive(request.params.id)
        await assertWritablePrimary()
        try {
        const { id } = request.params
        const password = request.headers['x-sync-password']
        const data = request.body
        trace('syncRoute', 'push.start', { accountId: id, compressed: !!data?.compressed })

        if (!id || !password) {
            trace('syncRoute', 'push.error', { accountId: id, error: 'missing-credentials' })
            reply.status(400);
            return { error: 'Missing ID or Password header' }
        }

        const bodyStr = JSON.stringify(data)
        const contentHash = crypto.createHash('sha256').update(bodyStr).digest('hex')
        const clientSyncedAt = data.syncedAt ? new Date(data.syncedAt).getTime() : 0
        const force = data.force === true
        // contentHint is the client's hash of its logical state (pre-syncedAt stamp); unlike
        // content_hash (over the random-IV envelope, never stable), a match proves the logical
        // content is unchanged so archive/rewrite/apiKeys churn and the updated_at bump skip.
        const clientHint = typeof data.contentHint === 'string' ? data.contentHint.slice(0, 64) : null
        // Revision base the client applied (its lastSyncedCloudEtag). Comparing
        // revisions mistakes no clock for another writer: a slow device clock no
        // longer self-conflicts, and rapid concurrent writes differing by <5s
        // still conflict via hash mismatch. Null for first pushes / legacy
        // snapshots: those fall back to the timestamp guard below.
        const clientBase = typeof data.baseContentHash === 'string' && data.baseContentHash ? data.baseContentHash : null
        const serverTime = new Date().toISOString()
        data.syncedAt = serverTime
        const storedStr = JSON.stringify(data)

        const serverStremioCredentialedAccounts = await listStremioCredentialedAccountIds(id)

        const pushedKeyHashes = new Set()
        if (data.apiKeys && typeof data.apiKeys === 'object') {
            for (const apiKey of Object.values(data.apiKeys)) {
                if (typeof apiKey === 'string' && apiKey) pushedKeyHashes.add(hashApiKey(apiKey))
            }
        }
        const storedKeyHashes = new Set(
            (await db.query('SELECT api_key_hash FROM account_api_keys WHERE sync_user = $1', [id])).map(r => r.api_key_hash),
        )
        let keysChanged = false
        for (const h of pushedKeyHashes) { if (!storedKeyHashes.has(h)) { keysChanged = true; break } }
        if (!keysChanged) {
            for (const h of storedKeyHashes) { if (!pushedKeyHashes.has(h)) { keysChanged = true; break } }
        }

        // scrypt (N=16384) must never run while the global SQLite tx queue is held
        // (finding #4): the hash depends only on headers, so compute it before the tx.
        // Device-authed pushes keep the stored password, so no hash is needed for them.
        // For an EXISTING row the stored scrypt hash already verifies this exact
        // password (a mismatch 401s below), so the UPDATE below keeps row.password and
        // only a possible REGISTRATION (row missing) pays the KDF — still outside the tx.
        // Password verification also runs before the tx; inside the tx only a string
        // compare re-checks that the stored credential is still the exact one verified.
        // The pre-tx result stays request-local: nothing reaches the shared auth cache
        // until the locked in-tx row confirms that exact credential, so a racing
        // request can never reuse a half-finished verification.
        const deviceSameAccount = request.deviceAuth?.accountUuid === id
        const preTxRow = deviceSameAccount ? null : await db.get('SELECT password FROM kv_store WHERE key = $1', [id])
        const preTxPassword = preTxRow?.password ?? null
        const rowMayExist = request.deviceAuth || preTxRow != null
        const precomputedHashedPass = (request.deviceAuth || rowMayExist) ? null : await hashSyncPassword(password)

        // Pre-tx verification against the just-read stored credential. A failure is
        // deferred, not answered: the row may legally change before the tx lands (a
        // client presenting the newer password after a racing restore must still
        // authenticate), and the in-tx re-check below stays the decision point then.
        // preVerified is an explicit boolean because verifiedPassword cannot carry the
        // outcome on its own: a NULL stored password also reads as null, and a
        // passwordless row must never authorize (P1-a).
        let preVerified = false
        let verifiedPassword = null // exact stored string the pre-tx check authenticated
        let legacyUpgrade = null // { legacy, hashed } pending upgrade of a legacy-format row
        if (!deviceSameAccount && preTxRow != null) {
            const cachedPw = getCachedAuthBound('sync:' + id, preTxPassword)
            if (cachedPw && timingSafeEqual(cachedPw, hashAuthPassword(password))) {
                preVerified = true
                verifiedPassword = preTxPassword
            } else {
                const verified = await verifySyncPassword(password, preTxPassword)
                let authorized = verified === true
                if (verified === null) {
                    const decryptedPassword = decrypt(preTxPassword, FALLBACK_KEYS)
                    if (decryptedPassword && timingSafeEqual(decryptedPassword, password)) {
                        authorized = true
                        // Legacy upgrade KDF runs here, outside the tx; the write itself
                        // is applied inside the tx below, exactly where it used to happen.
                        const hashed = await prepareLegacyPasswordUpgrade(id, password)
                        if (hashed) legacyUpgrade = { legacy: preTxPassword, hashed }
                    }
                }
                if (authorized) {
                    preVerified = true
                    verifiedPassword = preTxPassword
                }
            }
        }

        const runPushTx = () => db.tx(async (tx) => {
            const row = await tx.get(
                db.type === 'postgres'
                    ? 'SELECT password, content_hash, content_hint, updated_at FROM kv_store WHERE key = $1 FOR UPDATE'
                    : 'SELECT password, content_hash, content_hint, updated_at FROM kv_store WHERE key = $1',
                [id]
            )

            if (row) {
                let storedPassword = row.password
                if (!deviceSameAccount && preVerified && row.password === verifiedPassword) {
                    // The locked row holds exactly the credential verified before the tx,
                    // so the string compare alone confirms authorization. Publishing the
                    // cache entry here (not pre-tx) is what lets a racing restore's
                    // invalidation win, and the binding to the exact credential means a
                    // hit can only ever certify that same string.
                    if (legacyUpgrade) {
                        // Legacy row verified pre-tx: persist the scrypt upgrade inside this
                        // tx (same write the old in-tx path performed) and store the new hash.
                        storedPassword = await applyLegacyPasswordUpgrade(tx, id, legacyUpgrade.hashed) || storedPassword
                    }
                    setCachedAuth('sync:' + id, password, storedPassword)
                } else if (!deviceSameAccount) {
                    // The stored credential is not the exact string verified before the tx:
                    // it changed mid-request, the pre-tx check failed, or the row carries no
                    // password at all. Re-run the original check against the locked row;
                    // scrypt inside the tx is confined to this rare path.
                    const cachedPw = getCachedAuthBound('sync:' + id, row.password)
                    if (cachedPw && timingSafeEqual(cachedPw, hashAuthPassword(password))) {
                    } else if (row.password === preTxPassword) {
                        // Deterministic short-circuit: the pre-tx cache-miss check already
                        // failed against this exact stored string (the scrypt compare and
                        // the legacy decrypt compare are deterministic, and a NULL stored
                        // password fails both), so fail now without paying the KDF again
                        // while the tx queue is held.
                        reply.status(401);
                        return { error: 'Unauthorized: Password mismatch' }
                    } else {
                        const verified = await verifySyncPassword(password, row.password)
                        let authorized = verified === true
                        if (verified === null) {
                            const decryptedPassword = decrypt(row.password, FALLBACK_KEYS)
                            if (decryptedPassword && timingSafeEqual(decryptedPassword, password)) {
                                authorized = true
                                storedPassword = await upgradeLegacyPasswordHash(tx, id, password) || storedPassword
                            }
                        }
                        if (!authorized) {
                            reply.status(401);
                            return { error: 'Unauthorized: Password mismatch' }
                        }
                        setCachedAuth('sync:' + id, password, storedPassword)
                    }
                }

                const serverUpdated = row.updated_at || 0
                const currentSyncedAt = serverUpdated > 0 ? new Date(Number(serverUpdated)).toISOString() : serverTime
                // Modern clients send the revision they applied; legacy clients send
                // only a wall-clock baseline. The revision check is authoritative when
                // both sides carry one; otherwise the timestamp guard applies. force
                // (explicit user action) bypasses both, unchanged.
                const hasRevisionBase = clientBase !== null && row.content_hash != null
                const revisionConflict = hasRevisionBase && clientBase !== row.content_hash
                const clockConflict = clientSyncedAt > 0 && serverUpdated > 0 && clientSyncedAt < serverUpdated - 5000
                if (!force && (hasRevisionBase ? revisionConflict : clockConflict)) {
                    const detail = hasRevisionBase
                        ? 'cloud revision changed since the client pull'
                        : 'legacy client timestamp predates server state'
                    fastify.log.info({ category: 'Server' }, 'Overlap for ID ' + id + ': ' + detail + ', content-hash gates the write')
                    trace('syncRoute', 'push.success', { accountId: id, skipped: true, reason: 'conflict', keysChanged, timing: Date.now() - postStart })
                    // A rejected snapshot cannot replace the winner's key registry.
                    return { success: true, conflict: true, syncedAt: currentSyncedAt, contentHash: row.content_hash ?? null, serverStremioCredentialedAccounts }
                }

                // Revision checks precede even the no-op paths: a stale hint cannot
                // certify rejected local state or replace the winning key registry.
                if ((clientHint && row.content_hint === clientHint) || row.content_hash === contentHash) {
                    trace('syncRoute', 'push.success', { accountId: id, skipped: true, reason: 'unchanged', keysChanged, timing: Date.now() - postStart })
                    if (keysChanged && data.apiKeys && typeof data.apiKeys === 'object') {
                        await registerApiKeys(tx, id, data.apiKeys, Array.isArray(data.accounts) ? data.accounts : null)
                    }
                    // Receipts still describe what the server holds: a lost response
                    // before this retry may have committed the canonical writes, and
                    // empty receipts here would strand the caller's merge base.
                    const skipCanonical = await skipPathCanonicalReceipts(tx, id, data.canonicalAddons, fastify.log)
                    return {
                        success: true,
                        syncedAt: currentSyncedAt,
                        skipped: true,
                        contentHash: row.content_hash,
                        serverStremioCredentialedAccounts,
                        canonical: skipCanonical.receipts,
                        ...(Object.keys(skipCanonical.reasons).length > 0 ? { canonicalReasons: skipCanonical.reasons } : {}),
                    }
                }

                await archiveCurrentKV(tx, id, id)

                const encryptedVal = encrypt(storedStr, PRIMARY_KEY)
                // Device-authed pushes carry a token in x-sync-password; it must never become the stored account password.
                // An existing row keeps its verified scrypt hash (no re-salt churn per push).
                const hashedPass = request.deviceAuth ? storedPassword : (precomputedHashedPass ?? storedPassword)
                await tx.run(`
                    UPDATE kv_store
                    SET value = $1, password = $2, updated_at = $3, content_hash = $4, content_hint = $5
                    WHERE key = $6
                `, [encryptedVal, hashedPass, Date.now(), contentHash, clientHint, id])
            } else {
                // Device auth requires an existing account row; an INSERT here means the row vanished mid-request, so fail closed.
                if (request.deviceAuth) {
                    reply.status(401);
                    return { error: 'Unauthorized: Password mismatch' }
                }
                // Race guard: the pre-tx existence check saw a row but the tx does not
                // (account deleted mid-request). Never INSERT a null password hash —
                // fail closed and let the client retry.
                if (!precomputedHashedPass) {
                    reply.status(409);
                    return { error: 'Account changed during push; please retry' }
                }
                if (isRegistrationsClosed()) {
                    reply.status(403);
                    return { error: 'Registrations are closed on this instance.' }
                }
                const encryptedVal = encrypt(storedStr, PRIMARY_KEY)
                const hashedPass = precomputedHashedPass
                await tx.run(`
                    INSERT INTO kv_store (key, value, password, updated_at, content_hash, content_hint)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [id, encryptedVal, hashedPass, Date.now(), contentHash, clientHint])
            }

            const apiKeys = data.apiKeys
            if (apiKeys && typeof apiKeys === 'object') {
                await registerApiKeys(tx, id, apiKeys, Array.isArray(data.accounts) ? data.accounts : null)
            }

            // Server-readable canonical addon lists: the Hydra inbound source for Hubs the
            // server can't otherwise read (Nuvio-only / local-only). Midnight-safe: the guard
            // no-ops when an account's addon list is unchanged, so re-syncs don't churn the row.
            const canonicalAddons = data.canonicalAddons
            const canonicalWrites = []
            // Per-hub receipts: the client advances its canonical merge base only
            // for hubs the server confirmed it holds. Old clients ignore these.
            // Rejection reasons in the response are deliberately generic; the
            // specific cause stays in server logs and traces only.
            const canonicalReceipts = {}
            const canonicalReasons = {}
            if (canonicalAddons && typeof canonicalAddons === 'object') {
                const now = Date.now()
                const emptyCanonicalIds = new Set()
                const canonicalRows = []
                for (const [accountId, addons] of Object.entries(canonicalAddons)) {
                    if (!accountId || !Array.isArray(addons)) continue
                    canonicalRows.push([accountId, id, now])
                    if (addons.length === 0) emptyCanonicalIds.add(accountId)
                    canonicalWrites.push([accountId, addons])
                }
                // Shrink guard (mirror of the client fold's inbound-deletes-don't-shrink):
                // a client that never folded an external push has local=[] for an account
                // whose server store is populated; pushing that empty list would destroy
                // the external write. An empty incoming list never overwrites a non-empty
                // store UNLESS the client flags the hub in emptiedHubs — the fold marks a
                // hub once it merges external content in, so a later empty push from a
                // marked hub is a deliberate full removal, not a fold-starved client.
                const emptiedHubs = Array.isArray(data.emptiedHubs)
                    ? new Set(data.emptiedHubs.filter(h => typeof h === 'string'))
                    : new Set()
                if (emptyCanonicalIds.size > 0) {
                    for (const accountId of emptyCanonicalIds) {
                        if (emptiedHubs.has(accountId)) continue
                        const row = await tx.get(
                            'SELECT addon_list FROM account_canonical_addons WHERE account_id = $1 AND sync_user = $2',
                            [accountId, id],
                        )
                        if (row?.addon_list) {
                            const decrypted = decrypt(row.addon_list, FALLBACK_KEYS)
                            if (decrypted) {
                                try {
                                    const parsed = JSON.parse(decrypted)
                                    if (Array.isArray(parsed) && parsed.length > 0) {
                                        const idx = canonicalWrites.findIndex(([aid]) => aid === accountId)
                                        if (idx >= 0) canonicalWrites.splice(idx, 1)
                                        canonicalReceipts[accountId] = 'rejected'
                                        canonicalReasons[accountId] = 'not-applied'
                                        fastify.log.warn({ category: 'Sync', fmt: 'sync.canonical_skip', acct: accountId, reason: 'empty-push' }, `Canonical shrink guard: kept ${parsed.length} stored addon(s) for account ${accountId} (push carried an empty list — likely unfolded external write).`)
                                    }
                                } catch {}
                            }
                        }
                    }
                }
                const CANONICAL_CHUNK = 100
                for (let i = 0; i < canonicalRows.length; i += CANONICAL_CHUNK) {
                    const chunk = canonicalRows.slice(i, i + CANONICAL_CHUNK)
                    if (chunk.length === 0) continue
                    const placeholders = buildMultiRowPlaceholders(chunk.length, 3)
                    const params = chunk.flat()
                    const sql = db.type === 'postgres'
                        ? `INSERT INTO account_canonical_addons (account_id, sync_user, updated_at) VALUES ${placeholders} ON CONFLICT (account_id) DO NOTHING`
                        : `INSERT OR IGNORE INTO account_canonical_addons (account_id, sync_user, updated_at) VALUES ${placeholders}`
                    await tx.run(sql, params)
                }
                // Claim unowned legacy rows (sync_user '') for this push's hubs before
                // the ownership check and write. One conditional statement resolves the
                // legacy race on both databases: concurrent pushes serialize on the row,
                // the loser's claim matches zero rows and the check below rejects the
                // hub. Claiming also covers the identical-plaintext case, which the
                // write helper would otherwise skip without taking ownership. Sorted ids
                // keep concurrent claims locking rows in one order; steady state matches
                // nothing and writes nothing.
                const claimIds = canonicalRows.map(r => r[0]).sort()
                // Sorted IN-list parameters do not make Postgres lock rows in that
                // order, and chunk boundaries from a JS sort need not match the
                // database collation. Lock every blank-owner row of this push in one
                // database-ordered statement first; the chunked UPDATEs then only
                // re-take locks this transaction already holds. SQLite has no FOR
                // UPDATE and its single-writer tx queue already serializes claims.
                if (db.type === 'postgres' && claimIds.length > 0) {
                    await tx.query(
                        `SELECT account_id FROM account_canonical_addons WHERE sync_user = '' AND account_id = ANY($1::text[]) ORDER BY account_id FOR UPDATE`,
                        [claimIds],
                    )
                }
                for (let i = 0; i < claimIds.length; i += CANONICAL_CHUNK) {
                    const ids = claimIds.slice(i, i + CANONICAL_CHUNK)
                    const inList = ids.map((_, j) => `$${j + 2}`).join(', ')
                    await tx.run(
                        `UPDATE account_canonical_addons SET sync_user = $1 WHERE sync_user = '' AND account_id IN (${inList})`,
                        [id, ...ids],
                    )
                }
                const foreignIds = new Set()
                for (let i = 0; i < canonicalRows.length; i += CANONICAL_CHUNK) {
                    const ids = canonicalRows.slice(i, i + CANONICAL_CHUNK).map(r => r[0])
                    const inList = ids.map((_, j) => `$${j + 2}`).join(', ')
                    const others = await tx.query(
                        `SELECT account_id FROM account_canonical_addons WHERE sync_user NOT IN ($1, '') AND account_id IN (${inList})`,
                        [id, ...ids],
                    )
                    for (const r of others) foreignIds.add(r.account_id)
                }
                for (let i = canonicalWrites.length - 1; i >= 0; i--) {
                    if (!foreignIds.has(canonicalWrites[i][0])) continue
                    canonicalReceipts[canonicalWrites[i][0]] = 'rejected'
                    canonicalReasons[canonicalWrites[i][0]] = 'not-applied'
                    fastify.log.warn({ category: 'Sync', fmt: 'sync.canonical_skip', acct: canonicalWrites[i][0], reason: 'other-workspace' }, `Canonical write skipped: account ${maskContext(canonicalWrites[i][0])} belongs to another workspace.`)
                    canonicalWrites.splice(i, 1)
                }
                for (const [accountId, addons] of canonicalWrites) {
                    const { outcome } = await writeEncryptedIfChanged(
                        'account_canonical_addons',
                        { sql: 'account_id = $1 AND sync_user = $2', params: [accountId, id] },
                        'addon_list',
                        JSON.stringify(addons),
                        { alsoSet: { sync_user: id, updated_at: now }, runner: tx },
                    )
                    if (outcome === 'written') canonicalReceipts[accountId] = 'applied'
                    else if (outcome === 'unchanged') canonicalReceipts[accountId] = 'unchanged'
                    else {
                        // Zero-row write: the selector stopped matching between the
                        // claim above and this statement. Never acknowledge it; the
                        // server does not hold this workspace's snapshot.
                        canonicalReceipts[accountId] = 'rejected'
                        canonicalReasons[accountId] = 'not-applied'
                        fastify.log.warn({ category: 'Sync', fmt: 'sync.canonical_skip', acct: accountId, reason: 'not-matched' }, `Canonical write matched no row for ${maskContext(accountId)}; the hub changed ownership during this push.`)
                    }
                }
            }

            invalidateSyncResponseCache(id)
            // A successful push does NOT change the account password (it stores the
            // same verified value), so the 60s password cache stays valid — exactly
            // like the no-op/conflict early returns above. Restore and delete keep
            // their invalidations because they swap or remove the password.
            for (const [accountId] of canonicalWrites) {
                invalidateCanonicalAddons(accountId, id)
            }
            trace('syncRoute', 'push.success', { accountId: id, bytes: storedStr.length, timing: Date.now() - postStart })
            return {
                success: true,
                syncedAt: serverTime,
                contentHash,
                serverStremioCredentialedAccounts,
                canonical: canonicalReceipts,
                ...(Object.keys(canonicalReasons).length > 0 ? { canonicalReasons } : {}),
            }
        })
        // The ordered legacy-row pre-lock removes the known lock-order inversion, but
        // Postgres can still deadlock the push tx on another statement pair. db.tx
        // rolls the whole transaction back on deadlock, so one bounded re-run of the
        // identical envelope is safe (auth caches and reply status are idempotent).
        // Deadlock SQLSTATE only: at the default READ COMMITTED there is no
        // serialization-failure path, and SQLite cannot deadlock (single-writer queue).
        let pushOutcome
        try {
            pushOutcome = await runPushTx()
        } catch (err) {
            if (db.type !== 'postgres' || err?.code !== '40P01') throw err
            fastify.log.warn({ category: 'Sync', fmt: 'sync.push_deadlock', acct: id, retry: '2/2' }, `[${maskContext(id)}] Push transaction deadlocked on PostgreSQL; retrying once.`)
            trace('syncRoute', 'push.deadlock_retry', { accountId: id })
            pushOutcome = await runPushTx()
        }
        // Bounded WAL checkpoint after a real write only (skip/conflict return inside the
        // tx): an archive plus rewrite moves roughly twice the envelope into the WAL.
        if (db.type === 'sqlite' && pushOutcome?.success && !pushOutcome.skipped && !pushOutcome.conflict) {
            noteSyncWrite(storedStr.length * 2)
        }
        return pushOutcome
        } catch (err) {
            fastify.log.error({ category: 'Sync', fmt: 'sync.error', op: 'push', acct: request.params?.id ?? null, err }, `POST /api/sync error: ${err.message}`)
            trace('syncRoute', 'push.error', { accountId: request.params?.id, error: err.message, timing: Date.now() - postStart })
            reply.status(500)
            return { error: 'Internal sync error' }
        }
    })

    fastify.post('/api/sync/:id/restore', {
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        // Account state gate ahead of the archived-history read; outside the try below.
        await assertAccountActive(request.params.id)
        await assertWritablePrimary()
        const restoreStart = Date.now()
        const { id } = request.params
        const password = request.headers['x-sync-password']
        trace('syncRoute', 'restore.start', { accountId: id })

        if (!id || !password) {
            reply.status(400)
            return { error: 'Missing ID or Password header' }
        }

        try {
            const row = await db.get('SELECT password FROM kv_store WHERE key = $1', [id])
            if (!row) {
                reply.status(401)
                return { error: 'Unauthorized: Invalid credentials' }
            }

            const cachedPw = request.deviceAuth?.accountUuid === id ? null : getCachedAuth('sync:' + id)
            if (request.deviceAuth?.accountUuid !== id && !(cachedPw && timingSafeEqual(cachedPw, hashAuthPassword(password)))) {
                const verified = await verifySyncPassword(password, row.password)
                let authorized = verified === true
                let upgradedHash = null
                if (verified === null) {
                    const decryptedPassword = decrypt(row.password, FALLBACK_KEYS)
                    if (decryptedPassword && timingSafeEqual(decryptedPassword, password)) {
                        authorized = true
                        upgradedHash = await upgradeLegacyPasswordHash(db, id, password)
                    }
                }
                if (!authorized) {
                    reply.status(401)
                    return { error: 'Unauthorized: Invalid credentials' }
                }
                setCachedAuth('sync:' + id, password, upgradedHash || row.password)
            }

            const result = await db.tx(async (tx) => {
                const archived = await tx.get(
                    'SELECT value, password, content_hash, updated_at FROM kv_store_history WHERE key = $1 ORDER BY archived_at DESC LIMIT 1',
                    [id]
                )
                if (!archived) return { restored: false }

                await tx.run(
                    `UPDATE kv_store SET value = $1, password = $2, updated_at = $3, content_hash = $4, content_hint = NULL WHERE key = $5`,
                    [archived.value, archived.password, archived.updated_at, archived.content_hash, id]
                )
                return { restored: true }
            })

            invalidateCachedAuth('sync:' + id)
            if (result?.restored) invalidateSyncResponseCache(id)
            trace('syncRoute', 'restore.done', { accountId: id, restored: result?.restored, timing: Date.now() - restoreStart })
            if (!result?.restored) {
                reply.status(404)
                return { error: 'No previous cloud version is available to restore' }
            }
            return { success: true, restored: true }
        } catch (err) {
            fastify.log.error({ category: 'Sync', fmt: 'sync.error', op: 'restore', acct: id, err }, `POST /api/sync/${maskContext(id)}/restore error: ${err.message}`)
            trace('syncRoute', 'restore.error', { accountId: id, error: err.message, timing: Date.now() - restoreStart })
            reply.status(500)
            return { error: 'Internal restore error' }
        }
    })

    fastify.delete('/api/sync/:id', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        // Account state gate ahead of the password read and cascade; outside the try below.
        await assertAccountActive(request.params.id)
        await assertWritablePrimary()
        const delStart = Date.now()
        try {
        const { id } = request.params
        const password = request.headers['x-sync-password']
        trace('syncRoute', 'delete.start', { accountId: id })

        fastify.log.info({ category: 'Server' }, `Received DELETE request for ID: ${maskContext(id)}`)

        if (!id || !password) {
            fastify.log.warn({ category: 'Server' }, `DELETE failed: Missing header for ID ${maskContext(id)}`)
            trace('syncRoute', 'delete.error', { accountId: id, error: 'missing-credentials' })
            reply.status(400);
            return { error: 'Missing ID or Password header' }
        }

        const row = await db.get('SELECT password FROM kv_store WHERE key = $1', [id])

        if (!row) {
            fastify.log.warn({ category: 'Server' }, `DELETE failed: ID ${maskContext(id)} not found`)
            trace('syncRoute', 'delete.error', { accountId: id, error: 'not-found' })
            reply.status(401);
            return { error: 'Unauthorized: Invalid credentials' }
        }

        const cachedPw = request.deviceAuth?.accountUuid === id ? null : getCachedAuth('sync:' + id)
        if (cachedPw && timingSafeEqual(cachedPw, hashAuthPassword(password))) {
        } else if (request.deviceAuth?.accountUuid !== id) {
            const verified = await verifySyncPassword(password, row.password)
            let authorized = verified === true
            if (verified === null) {
                const decryptedPassword = decrypt(row.password, FALLBACK_KEYS)
                authorized = !!decryptedPassword && timingSafeEqual(decryptedPassword, password)
            }
            if (!authorized) {
                fastify.log.warn({ category: 'Server' }, `DELETE failed: Password mismatch for ID ${maskContext(id)}`)
                trace('syncRoute', 'delete.error', { accountId: id, error: 'password-mismatch' })
                reply.status(401);
                return { error: 'Unauthorized: Invalid credentials' }
            }
            setCachedAuth('sync:' + id, password, row.password)
        }

        fastify.log.info({ category: 'Server' }, `Deleting all data for sync user: ${maskContext(id)}`)
        await db.tx(async (tx) => {
            await tx.run('DELETE FROM activity_events WHERE sync_user = $1', [id])
            await tx.run('DELETE FROM activity_snapshots WHERE sync_user = $1', [id])
            await tx.run('DELETE FROM account_canonical_addons WHERE sync_user = $1', [id])
            await tx.run('DELETE FROM server_credentials WHERE sync_user = $1', [id])
            await tx.run('DELETE FROM device_credentials WHERE account_uuid = $1', [id])
            // Without these, deleting a sync user leaves valid API keys + subscriber rows that
            // still authenticate to /hydra/* for the now-deleted user.
            await tx.run('DELETE FROM account_api_keys WHERE sync_user = $1', [id])
            await tx.run('DELETE FROM hydra_subscribers WHERE sync_user = $1', [id])
            await tx.run('DELETE FROM account_addon_actions WHERE sync_user = $1', [id])
            await tx.run('DELETE FROM autopilot_rule_stats WHERE rule_id IN (SELECT id FROM autopilot_rules WHERE owner_sync_user = $1)', [id])
            await tx.run('DELETE FROM failover_history WHERE rule_id IN (SELECT id FROM autopilot_rules WHERE owner_sync_user = $1)', [id])
            await tx.run('DELETE FROM autopilot_rules WHERE owner_sync_user = $1', [id])
            await tx.run('DELETE FROM account_admin_state WHERE sync_user = $1', [id])
            await tx.run('DELETE FROM account_notices WHERE sync_user = $1', [id])
            await tx.run('DELETE FROM kv_store WHERE key = $1', [id])
            await tx.run('DELETE FROM kv_store_history WHERE key = $1', [id])
        })
        invalidateCachedAuth('sync:' + id)
        invalidateSyncResponseCache(id)
        // The cascade cleared any admin state and notices for the user; pick that up now.
        await refreshAccountAdminState().catch(() => {})
        const { invalidateConnectionCache } = await import('../providers/reconciler.js')
        invalidateConnectionCache(id)
        trace('syncRoute', 'delete.success', { accountId: id, timing: Date.now() - delStart })

        return { success: true }
        } catch (err) {
            fastify.log.error({ category: 'Server' }, `DELETE failed: ${err.message}`)
            trace('syncRoute', 'delete.error', { accountId: request.params?.id, error: err.message, timing: Date.now() - delStart })
            reply.status(500)
            return { error: 'Internal server error' }
        }
    })
}
