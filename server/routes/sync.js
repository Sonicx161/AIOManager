import crypto from 'crypto'
import db from '../db.js'
import { encrypt, decrypt } from '../crypto.js'
import { PRIMARY_KEY, FALLBACK_KEYS } from '../keys.js'
import { getCachedAuth, setCachedAuth, invalidateCachedAuth, hashAuthPassword } from '../state.js'
import { timingSafeEqual } from '../auth.js'
import { hashApiKey } from '../api-keys.js'
import { writeEncryptedIfChanged } from '../db-guards.js'
import { invalidateCanonicalAddons } from './hydra.js'
import { listStremioCredentialedAccountIds } from '../lib/stremio-credentials.js'
import { hashSyncPassword, isScryptHash, verifySyncPassword, upgradeLegacyPasswordHash } from '../lib/sync-password.js'
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
                setCachedAuth('sync:' + id, password)
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
        const rowMayExist = request.deviceAuth || !!(await db.get('SELECT 1 AS ok FROM kv_store WHERE key = $1', [id]))
        const precomputedHashedPass = (request.deviceAuth || rowMayExist) ? null : await hashSyncPassword(password)

        const pushOutcome = await db.tx(async (tx) => {
            const row = await tx.get(
                db.type === 'postgres'
                    ? 'SELECT password, content_hash, content_hint, updated_at FROM kv_store WHERE key = $1 FOR UPDATE'
                    : 'SELECT password, content_hash, content_hint, updated_at FROM kv_store WHERE key = $1',
                [id]
            )

            if (row) {
                let storedPassword = row.password
                const cachedPw = request.deviceAuth?.accountUuid === id ? null : getCachedAuth('sync:' + id)
                if (cachedPw && timingSafeEqual(cachedPw, hashAuthPassword(password))) {
                } else if (request.deviceAuth?.accountUuid !== id) {
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
                    setCachedAuth('sync:' + id, password)
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
                    return { success: true, syncedAt: currentSyncedAt, skipped: true, contentHash: row.content_hash, serverStremioCredentialedAccounts }
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
                    fastify.log.warn({ category: 'Sync', fmt: 'sync.canonical_skip', acct: canonicalWrites[i][0], reason: 'other-workspace' }, `Canonical write skipped: account ${maskContext(canonicalWrites[i][0])} belongs to another workspace.`)
                    canonicalWrites.splice(i, 1)
                }
                for (const [accountId, addons] of canonicalWrites) {
                    await writeEncryptedIfChanged(
                        'account_canonical_addons',
                        { sql: "account_id = $1 AND sync_user IN ($2, '')", params: [accountId, id] },
                        'addon_list',
                        JSON.stringify(addons),
                        { alsoSet: { sync_user: id, updated_at: now }, runner: tx },
                    )
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
            return { success: true, syncedAt: serverTime, contentHash, serverStremioCredentialedAccounts }
        })
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
                if (verified === null) {
                    const decryptedPassword = decrypt(row.password, FALLBACK_KEYS)
                    if (decryptedPassword && timingSafeEqual(decryptedPassword, password)) {
                        authorized = true
                        await upgradeLegacyPasswordHash(db, id, password)
                    }
                }
                if (!authorized) {
                    reply.status(401)
                    return { error: 'Unauthorized: Invalid credentials' }
                }
                setCachedAuth('sync:' + id, password)
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
            setCachedAuth('sync:' + id, password)
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
