// DP-05 operator actions over sync accounts: disable/enable, soft delete/restore,
// sign out devices, bulk soft delete, user notices. Accounts are referenced only by
// their acct-<12hex> handle; resolved keys never leave the server; every mutation is
// one audited transaction plus a fixed-template notice, idempotent where noted.
import crypto from 'crypto'
import db from '../db.js'
import { verifyAuth } from '../auth.js'
import { invalidateCachedAuth, invalidateCachedAuthPrefix } from '../state.js'
import { auditedTx } from './audit.js'
import { refreshAccountAdminState, patchLocalAccountState } from './account-state.js'
import { accountHandle } from '../utils/acct-handle.js'
import { isReadOnlyReplica } from '../config.js'

const DAY_MS = 24 * 60 * 60 * 1000
const NOTICE_CAP = 20
const BULK_RESTORE_WINDOW_DAYS = 30
const REASON_MIN = 3
const REASON_MAX = 500
const REASON_AUDIT_MAX = 200
const HANDLE_RE = /^acct-[0-9a-f]{12}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BULK_ATTEMPTS = 3

export const NOTICE_TEMPLATES = {
    'account.disabled': "Your instance's Dashboard disabled your account.",
    'account.enabled': "Your instance's Dashboard re-enabled your account.",
    'account.deleted': "Your instance's Dashboard deleted your account. Data is kept.",
    'account.restored': "Your instance's Dashboard restored your account.",
    'account.signed_out': "Your instance's Dashboard signed out the devices for your account.",
    'repair.release-sync-lease': "Your instance's Dashboard cleared the sync server caches for your account.",
    'repair.clear-server-caches': "Your instance's Dashboard cleared server caches for your account. Some responses may be slower for a few minutes.",
    'repair.reset-activity-breaker': "Your instance's Dashboard reset the activity scan backoff for your account.",
    'repair.recheck-failover': "Your instance's Dashboard re-ran a health check on your Failover rules.",
    'repair.clear-login-backoff': "Your instance's Dashboard cleared the login backoff for your account.",
}

const sha256hex = (text) => crypto.createHash('sha256').update(text).digest('hex')

// Deterministic id over (user, key, action timestamp): an audited action replayed
// after commit cannot double-notify. Dedupe is separate from the retention cap.
// Shared by the account actions and the DP-04 repairs (one notice per audited run).
export async function appendUserNotice(tx, syncUser, noticeKey, actionTs) {
    const id = sha256hex(`${syncUser}|${noticeKey}|${actionTs}`)
    await tx.run(
        db.type === 'postgres'
            ? 'INSERT INTO account_notices (id, sync_user, notice_key, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING'
            : 'INSERT OR IGNORE INTO account_notices (id, sync_user, notice_key, created_at) VALUES ($1, $2, $3, $4)',
        [id, syncUser, noticeKey, actionTs]
    )
    await tx.run(
        `DELETE FROM account_notices WHERE sync_user = $1 AND id NOT IN (SELECT id FROM account_notices WHERE sync_user = $2 ORDER BY created_at DESC, id ASC LIMIT ${NOTICE_CAP})`,
        [syncUser, syncUser]
    )
}

// Server-only handle resolution (the reverse of accountHandle): scan kv_store keys,
// hash each, group by handle. Runs only inside admin route handlers; resolved keys
// never appear in a response, a log line or an audit detail.
export async function resolveAccountKeys(handles = null, { handleOf = accountHandle } = {}) {
    const rows = await db.query('SELECT key FROM kv_store', [])
    const byHandle = new Map()
    for (const row of rows) {
        if (!UUID_RE.test(String(row.key))) continue
        const handle = handleOf(row.key)
        const keys = byHandle.get(handle) || []
        keys.push(row.key)
        byHandle.set(handle, keys)
    }
    if (handles == null) return { map: byHandle }
    const map = new Map()
    for (const handle of handles) map.set(handle, byHandle.get(handle) || [])
    return { map: byHandle, requested: map }
}

// One handle must map to exactly one key: zero is an unknown handle, more than one
// is a truncated-HMAC collision the code must reject, never guess. handleOf is
// injectable so tests can synthesize that (practically impossible) collision.
export async function resolveHandleToKey(handle, { handleOf = accountHandle } = {}) {
    if (!HANDLE_RE.test(String(handle))) return { error: 'unknown' }
    const { requested } = await resolveAccountKeys([String(handle)], { handleOf })
    const keys = requested.get(String(handle))
    if (!keys || keys.length === 0) return { error: 'unknown' }
    if (keys.length > 1) return { error: 'ambiguous' }
    return { key: keys[0] }
}

export function invalidReason(reason) {
    const trimmed = typeof reason === 'string' ? reason.trim() : ''
    if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) return true
    return false
}

export function auditReason(reason) {
    return String(reason).trim().slice(0, REASON_AUDIT_MAX)
}

// After a committed mutation the snapshot refresh must not be able to fail open: on
// a read blip the route patches the row it just committed and schedules a verify.
async function refreshSnapshotAfterMutation(key, localState) {
    try {
        await refreshAccountAdminState()
    } catch {
        patchLocalAccountState(key, localState)
        console.warn('[AccountState] Post-commit refresh failed; patched the local snapshot from the committed row.')
    }
}

function invalidateAccountCaches(key) {
    invalidateCachedAuth('sync:' + key)
    invalidateCachedAuthPrefix('device:' + key + ':')
}

async function readStateRow(tx, key) {
    return tx.get('SELECT sync_user, disabled_at, deleted_at, restore_until FROM account_admin_state WHERE sync_user = $1', [key])
}

// Committed-state helper for post-mutation snapshot patching (a read failure here
// must never resurrect a blocked account in the in-memory view).
async function readFullState(key) {
    try {
        const row = await db.get('SELECT disabled_at, deleted_at, restore_until FROM account_admin_state WHERE sync_user = $1', [key])
        if (!row) return null
        return {
            disabledAt: row.disabled_at == null ? null : Number(row.disabled_at),
            deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
            restoreUntil: row.restore_until == null ? null : Number(row.restore_until),
        }
    } catch {
        return null
    }
}

async function upsertState(tx, key, fields, now) {
    await tx.run(
        `INSERT INTO account_admin_state (sync_user, disabled_at, deleted_at, restore_until, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (sync_user) DO UPDATE SET disabled_at = $6, deleted_at = $7, restore_until = $8, updated_at = $9`,
        [key, fields.disabledAt ?? null, fields.deletedAt ?? null, fields.restoreUntil ?? null, now, fields.disabledAt ?? null, fields.deletedAt ?? null, fields.restoreUntil ?? null, now]
    )
}

// One shared shape for the five single-account actions. The action runs inside an
// audited transaction with its notice; idempotent repeats write no second row.
export function createAccountActions({ log = console } = {}) {
    async function withHandle(reply, handle, fn) {
        const resolved = await resolveHandleToKey(handle)
        if (resolved.error === 'unknown') {
            reply.status(404)
            return { error: 'Account not found' }
        }
        if (resolved.error === 'ambiguous') {
            log.warn(`[Dashboard] Handle ${handle} resolved to more than one account key; refusing to act.`)
            reply.status(500)
            return { error: 'handle_ambiguous' }
        }
        return fn(resolved.key)
    }

    const guardBody = (reply, body, confirmToken) => {
        if (invalidReason(body?.reason)) {
            reply.status(400)
            return { error: `A reason between ${REASON_MIN} and ${REASON_MAX} characters is required.` }
        }
        if (body?.confirm !== confirmToken) {
            reply.status(400)
            return { error: `Confirm with the exact word ${confirmToken}.` }
        }
        return null
    }

    const disable = (reply, handle, body, auditEntry) => withHandle(reply, handle, async (key) => {
        const invalid = guardBody(reply, body, 'DISABLE')
        if (invalid) return invalid
        const now = Date.now()
        const result = await auditedTx(async (tx) => {
            const row = await readStateRow(tx, key)
            if (row?.deleted_at) return { conflict: true }
            if (row?.disabled_at) return { idempotent: true }
            await upsertState(tx, key, { disabledAt: now }, now)
            await appendUserNotice(tx, key, 'account.disabled', now)
            return { written: true }
        }, (result) => (result.written ? { ...auditEntry, event: 'account.disable', details: { handle, reason: auditReason(body.reason) } } : null))
        if (result.conflict) {
            reply.status(409)
            return { error: 'account_deleted' }
        }
        await refreshSnapshotAfterMutation(key, { disabledAt: now, deletedAt: null, restoreUntil: null })
        invalidateAccountCaches(key)
        return { ok: true, status: 'disabled' }
    })

    const enable = (reply, handle, body, auditEntry) => withHandle(reply, handle, async (key) => {
        const invalid = guardBody(reply, body, 'ENABLE')
        if (invalid) return invalid
        const result = await auditedTx(async (tx) => {
            const row = await readStateRow(tx, key)
            if (row?.deleted_at) return { conflict: true }
            if (!row?.disabled_at) return { idempotent: true }
            await tx.run('DELETE FROM account_admin_state WHERE sync_user = $1', [key])
            await appendUserNotice(tx, key, 'account.enabled', Date.now())
            return { written: true }
        }, (result) => (result.written ? { ...auditEntry, event: 'account.enable', details: { handle, reason: auditReason(body.reason) } } : null))
        if (result.conflict) {
            reply.status(409)
            return { error: 'account_deleted' }
        }
        await refreshSnapshotAfterMutation(key, null)
        invalidateAccountCaches(key)
        return { ok: true, status: 'active' }
    })

    const remove = (reply, handle, body, auditEntry) => withHandle(reply, handle, async (key) => {
        const invalid = guardBody(reply, body, 'DELETE')
        if (invalid) return invalid
        const now = Date.now()
        const restoreUntil = now + BULK_RESTORE_WINDOW_DAYS * DAY_MS
        const result = await auditedTx(async (tx) => {
            const row = await readStateRow(tx, key)
            if (row?.deleted_at) return { idempotent: true, restoreUntil: Number(row.restore_until) || restoreUntil }
            // A prior operator disable survives the delete: deleted outranks disabled
            // while deleted, and restore returns the account to disabled, not active.
            await upsertState(tx, key, { disabledAt: row?.disabled_at == null ? null : Number(row.disabled_at), deletedAt: now, restoreUntil }, now)
            await appendUserNotice(tx, key, 'account.deleted', now)
            return { written: true, restoreUntil }
        }, (result) => (result.written ? { ...auditEntry, event: 'account.delete', details: { handle, reason: auditReason(body.reason) } } : null))
        // Patch from the committed row (idempotent repeats included) so a failed
        // refresh cannot resurrect the account in the in-memory view.
        const committed = await readFullState(key)
        await refreshSnapshotAfterMutation(key, committed ?? { disabledAt: null, deletedAt: now, restoreUntil })
        invalidateAccountCaches(key)
        return { ok: true, status: 'deleted', restoreUntil: new Date(result.restoreUntil).toISOString() }
    })

    const restore = (reply, handle, body, auditEntry) => withHandle(reply, handle, async (key) => {
        const invalid = guardBody(reply, body, 'RESTORE')
        if (invalid) return invalid
        const now = Date.now()
        const result = await auditedTx(async (tx) => {
            const row = await readStateRow(tx, key)
            if (!row) return { idempotent: true, status: 'active' }
            if (!row.deleted_at) return { refused: true }
            // Restore clears the delete fields; a preserved operator disable returns
            // with them, so a restored account is only active if it was never disabled.
            const disabledAt = row.disabled_at == null ? null : Number(row.disabled_at)
            if (disabledAt == null) await tx.run('DELETE FROM account_admin_state WHERE sync_user = $1', [key])
            else await upsertState(tx, key, { disabledAt, deletedAt: null, restoreUntil: null }, now)
            await appendUserNotice(tx, key, 'account.restored', now)
            return { written: true, status: disabledAt == null ? 'active' : 'disabled', committedDisabledAt: disabledAt }
        }, (result) => (result.written ? { ...auditEntry, event: 'account.restore', details: { handle, reason: auditReason(body.reason) } } : null))
        if (result.refused) {
            reply.status(409)
            return { error: 'account_not_deleted', message: 'Only a deleted account can be restored.' }
        }
        // The committed disabled_at is the patch source of truth; a restore whose
        // result is disabled must never patch null, even when verification reads fail.
        await refreshSnapshotAfterMutation(key, result.status === 'disabled'
            ? (await readFullState(key)) ?? { disabledAt: result.committedDisabledAt, deletedAt: null, restoreUntil: null }
            : null)
        invalidateAccountCaches(key)
        return { ok: true, status: result.status }
    })

    // Shipped revoke-everywhere semantics: a credential_epoch bump plus cache
    // invalidations. No device rows are marked; api keys and provider connections
    // keep working. Works on disabled and deleted accounts alike.
    // Repeat rule: with no device activity (use or enrollment) since the previous
    // sign out, the repeat is a no-op (no bump, audit or notice). The marker is
    // account_admin_state.signed_out_at, not the capped notice feed.
    const signoutDevices = (reply, handle, body, auditEntry) => withHandle(reply, handle, async (key) => {
        const invalid = guardBody(reply, body, 'SIGNOUT')
        if (invalid) return invalid
        const now = Date.now()
        const result = await auditedTx(async (tx) => {
            const account = await tx.get('SELECT credential_epoch FROM kv_store WHERE key = $1', [key])
            if (!account) return { missing: true }
            const devices = await tx.get(
                'SELECT COUNT(*) AS n, MAX(CASE WHEN last_used_at > created_at THEN last_used_at ELSE created_at END) AS activity FROM device_credentials WHERE account_uuid = $1',
                [key]
            )
            const deviceCount = Number(devices?.n || 0)
            const activity = devices?.activity == null ? null : Number(devices.activity)
            const state = await tx.get('SELECT signed_out_at FROM account_admin_state WHERE sync_user = $1', [key])
            const lastSignoutAt = Number(state?.signed_out_at) || 0
            if (lastSignoutAt > 0 && (activity == null || activity <= lastSignoutAt)) {
                return { noop: true, devices: deviceCount, credentialEpoch: Number(account.credential_epoch) }
            }
            const nextEpoch = (Number(account.credential_epoch) || 1) + 1
            await tx.run('UPDATE kv_store SET credential_epoch = $1 WHERE key = $2', [nextEpoch, key])
            await tx.run(
                db.type === 'postgres'
                    ? 'INSERT INTO account_admin_state (sync_user, updated_at, signed_out_at) VALUES ($1, $2, $3) ON CONFLICT (sync_user) DO UPDATE SET signed_out_at = $3, updated_at = $2'
                    // sqlite expands each $n to its own bind, so reused values need distinct slots.
                    : 'INSERT INTO account_admin_state (sync_user, updated_at, signed_out_at) VALUES ($1, $2, $3) ON CONFLICT(sync_user) DO UPDATE SET signed_out_at = $4, updated_at = $5',
                db.type === 'postgres' ? [key, now, now] : [key, now, now, now, now]
            )
            await appendUserNotice(tx, key, 'account.signed_out', now)
            return { nextEpoch, devices: deviceCount }
        }, (result) => (result.missing || result.noop ? null : { ...auditEntry, event: 'account.signout_devices', details: { handle, reason: auditReason(body.reason) } }))
        if (result.missing) {
            reply.status(404)
            return { error: 'Account not found' }
        }
        if (!result.noop) invalidateAccountCaches(key)
        return { ok: true, devices: result.devices, credentialEpoch: result.credentialEpoch ?? result.nextEpoch }
    })

    return { disable, enable, remove, restore, signoutDevices }
}

// Bulk soft delete: the preview reads the cached aggregate and resolves handles to
// keys; the confirm re-derives everything authoritatively inside one mutation
// transaction, hashes the resolved key set and refuses drift with 409.
export function createBulkDelete({ users, log = console, runner = null, handleOf = accountHandle } = {}) {
    // Last preview per admin session, so a confirm can compare the exact set even
    // when the count alone has not moved. In memory only; a restart drops it.
    const previews = new Map()
    const PREVIEW_TTL_MS = 10 * 60_000
    const execTx = runner || ((fn, entryFor, opts) => auditedTx(fn, entryFor, opts))

    const candidatesFromAggregate = (list, now) => list
        .filter((u) => (u.inactiveDays === null || u.inactiveDays >= 180) && u.status !== 'deleted')
        .sort((a, b) => (b.inactiveDays ?? 1e9) - (a.inactiveDays ?? 1e9) || a.handle.localeCompare(b.handle))

    const hashKeys = (keys) => sha256hex([...keys].sort().join('\n'))

    async function preview(reply, sessionHash) {
        const { users: all } = await users()
        const candidates = candidatesFromAggregate(all, Date.now()).slice(0, 25)
        const { requested } = await resolveAccountKeys(candidates.map((c) => c.handle))
        const keys = candidates.flatMap((c) => requested.get(c.handle) || [])
        const setHash = hashKeys(keys)
        previews.set(sessionHash, { setHash, expected: candidates.length, at: Date.now() })
        return { expected: candidates.length, setHash, cap: 25 }
    }

    // Authoritative per-key inactivity from the source of truth, mirroring the
    // aggregate computation (reads.js): max(kv updated_at, device last_used_at,
    // hydra last_seen_at); a never-seen account counts as most inactive. Candidate
    // handles are re-resolved inside the transaction: a handle with no key left is
    // set drift, a handle with more than one key is a collision and never guessed.
    async function recheckCandidates(tx, now) {
        const kv = await tx.query('SELECT key, updated_at FROM kv_store', [])
        const byHandle = new Map()
        for (const row of kv) {
            if (!UUID_RE.test(String(row.key))) continue
            const handle = handleOf(row.key)
            const keys = byHandle.get(handle) || []
            keys.push(row.key)
            byHandle.set(handle, keys)
        }
        const devices = await tx.query('SELECT account_uuid, MAX(last_used_at) AS last_used FROM device_credentials WHERE revoked = 0 GROUP BY account_uuid', [])
        const subs = await tx.query('SELECT sync_user, MAX(last_seen_at) AS last_seen FROM hydra_subscribers GROUP BY sync_user', [])
        const deleted = new Set((await tx.query('SELECT sync_user FROM account_admin_state WHERE deleted_at IS NOT NULL', [])).map((r) => r.sync_user))
        const disabledBy = new Map((await tx.query('SELECT sync_user, disabled_at FROM account_admin_state WHERE disabled_at IS NOT NULL', [])).map((r) => [r.sync_user, r.disabled_at == null ? null : Number(r.disabled_at)]))
        const deviceBy = new Map(devices.map((r) => [r.account_uuid, Number(r.last_used) || 0]))
        const subBy = new Map(subs.map((r) => [r.sync_user, Number(r.last_seen) || 0]))
        const candidates = []
        let matches = 0
        for (const row of kv) {
            const key = String(row.key)
            if (!UUID_RE.test(key) || deleted.has(key)) continue
            const handle = handleOf(key)
            const mapping = byHandle.get(handle) || []
            if (mapping.length > 1) {
                const err = new Error('handle_ambiguous')
                err.code = 'bulk_ambiguous'
                throw err
            }
            const lastSeen = Math.max(Number(row.updated_at) || 0, deviceBy.get(key) || 0, subBy.get(key) || 0)
            if (lastSeen > 0 && now - lastSeen < 180 * DAY_MS) continue
            matches++
            candidates.push({ key, handle, updatedAt: Number(row.updated_at) || 0, disabledAt: disabledBy.get(key) ?? null, inactiveDays: lastSeen > 0 ? Math.floor((now - lastSeen) / DAY_MS) : 1e9 })
        }
        candidates.sort((a, b) => b.inactiveDays - a.inactiveDays || a.handle.localeCompare(b.handle))
        let locked = candidates.slice(0, 25)
        if (db.type === 'postgres' && locked.length > 0) {
            // Candidate lock (N4/S-9): row locks on exactly the kv_store keys, held to
            // commit. A row that vanished or changed under the lock drops out and the
            // surviving hash surfaces the drift as 409.
            const inList = locked.map((_, i) => `$${i + 1}`).join(', ')
            const rows = await tx.query(`SELECT key, updated_at FROM kv_store WHERE key IN (${inList}) FOR UPDATE`, locked.map((c) => c.key))
            const byKey = new Map(rows.map((r) => [String(r.key), Number(r.updated_at) || 0]))
            locked = locked.filter((c) => byKey.has(c.key) && byKey.get(c.key) === c.updatedAt)
        }
        return { candidates: locked, matches }
    }

    async function confirm(reply, sessionHash, body, auditEntry) {
        if (invalidReason(body?.reason)) {
            reply.status(400)
            return { error: `A reason between ${REASON_MIN} and ${REASON_MAX} characters is required.` }
        }
        const clientExpected = /^DELETE (\d+)$/.exec(String(body?.confirm || ''))
        if (!clientExpected) {
            reply.status(400)
            return { error: 'Confirm with DELETE and the previewed count, for example DELETE 12.' }
        }
        const clientCount = Number(clientExpected[1])
        const now = Date.now()

        const run = () => execTx(async (tx) => {
            const { candidates, matches } = await recheckCandidates(tx, now)
            const keys = candidates.map((c) => c.key)
            const setHash = hashKeys(keys)
            const prior = previews.get(sessionHash)
            if ((prior && now - prior.at <= PREVIEW_TTL_MS && prior.setHash !== setHash) || clientCount !== keys.length) {
                // Roll back and hand the recomputed set back for the 409 body.
                throw Object.assign(new Error('bulk delete set changed'), { code: 'bulk_drift', expected: keys.length, setHash })
            }
            for (const candidate of candidates) {
                // A prior operator disable survives the bulk delete, exactly like the
                // single-account path; restore returns those accounts to disabled.
                await upsertState(tx, candidate.key, { disabledAt: candidate.disabledAt, deletedAt: now, restoreUntil: now + BULK_RESTORE_WINDOW_DAYS * DAY_MS }, now)
                await appendUserNotice(tx, candidate.key, 'account.deleted', now)
            }
            return { deleted: keys.length, matches, keys, disabledAtBy: candidates.map((c) => c.disabledAt), handles: candidates.map((c) => c.handle), setHash }
        }, (result) => ({
            ...auditEntry,
            event: 'account.bulk_delete',
            details: { count: result.deleted, setHash: result.setHash, reason: auditReason(body.reason), accounts: result.handles },
        }), {
            // SERIALIZABLE aborts only a racing confirm on postgres and lets the retry's
            // recheck drop a just-used candidate; sqlite takes the single-writer lock.
            txOpts: db.type === 'postgres' ? { isolation: 'SERIALIZABLE' } : { immediate: true },
        })

        for (let attempt = 1; ; attempt++) {
            let result
            try {
                result = await run()
            } catch (err) {
                if (err?.code === 'bulk_drift') {
                    previews.set(sessionHash, { setHash: err.setHash, expected: err.expected, at: now })
                    reply.status(409)
                    return { error: 'Count changed, confirm again', expected: err.expected, setHash: err.setHash }
                }
                if (err?.code === 'bulk_ambiguous') {
                    log.warn('[Dashboard] Bulk delete refused: a handle resolved to more than one account key.')
                    reply.status(500)
                    return { error: 'handle_ambiguous' }
                }
                const retryable = db.type === 'postgres' && (err?.code === '40001' || err?.code === '40P01')
                if (retryable && attempt < BULK_ATTEMPTS) continue
                if (retryable) {
                    reply.header('Retry-After', '30')
                    reply.status(503)
                    return { error: 'bulk_delete_busy', message: 'The delete set is changing too fast. Try again shortly.' }
                }
                throw err
            }
            // Patch every deleted key from the committed result before the refresh so a
            // failed post-commit read cannot un-enforce the bulk delete; the refresh
            // then verifies asynchronously. Preserved disables ride the patch.
            result.keys.forEach((key, i) => {
                patchLocalAccountState(key, { disabledAt: result.disabledAtBy[i] ?? null, deletedAt: now, restoreUntil: now + BULK_RESTORE_WINDOW_DAYS * DAY_MS })
            })
            refreshAccountAdminState().catch(() => {})
            for (const key of result.keys) invalidateAccountCaches(key)
            return { ok: true, deleted: result.deleted, remaining: Math.max(0, result.matches - result.deleted), cap: 25 }
        }
    }

    return { preview, confirm }
}

// User-facing notice read: verifyAuth carries the account state gate. seen_at is
// stamped on the primary only; a replica returns rows unstamped and never writes.
export function registerAccountNoticeRoutes(fastify) {
    fastify.get('/api/account/notices', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const syncUser = await verifyAuth(request)
        if (!syncUser) {
            reply.status(401)
            return { error: 'Unauthorized' }
        }
        const rows = await db.query(
            `SELECT id, notice_key, created_at, seen_at FROM account_notices WHERE sync_user = $1 ORDER BY created_at DESC, id ASC LIMIT ${NOTICE_CAP}`,
            [syncUser]
        )
        let stamp = null
        if (!isReadOnlyReplica() && rows.some((r) => r.seen_at == null)) {
            stamp = Date.now()
            await db.run('UPDATE account_notices SET seen_at = $1 WHERE sync_user = $2 AND seen_at IS NULL', [stamp, syncUser])
        }
        return {
            notices: rows.map((r) => ({
                id: r.id,
                noticeKey: r.notice_key,
                message: NOTICE_TEMPLATES[r.notice_key] || r.notice_key,
                createdAt: Number(r.created_at),
                seenAt: r.seen_at == null ? null : Number(r.seen_at),
            })),
        }
    })
}
