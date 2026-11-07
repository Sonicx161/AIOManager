// DP-04 tier-1 repairs: cache resets plus one probe-only Failover recheck, one
// sync account at a time. Every run is one audited transaction with a fixed-
// template notice; dry runs change nothing. Accounts are referenced only by their
// handle; resolved keys and rule ids never leave the server.
import db from '../db.js'
import { auditedTx } from './audit.js'
import { appendUserNotice, invalidReason, auditReason, resolveHandleToKey, NOTICE_TEMPLATES } from './account-actions.js'
import { assertAccountActive, assertWritablePrimary, AuthStateError } from './account-state.js'
import { REPAIR_CATALOG, AVAILABLE_REPAIRS, repairCatalogForStatus } from './reads.js'
import { authCache, invalidateCachedAuth, invalidateCachedAuthPrefix } from '../state.js'
import { invalidateSyncResponseCache, peekSyncResponseCache } from '../lib/sync-response-cache.js'
import { invalidateCanonicalForOwner, canonicalCacheCountForOwner } from '../hydra/canonical-cache.js'
import { dropConnectionCacheForOwner, connectionCacheCountForOwner } from '../providers/reconciler.js'
import { resetBreakerForOwner, breakerSummaryForOwner } from '../activity/engine.js'

const HISTORY_LIMIT = 20
const HANDLE_RE = /^acct-[0-9a-f]{12}$/

const countAuthEntries = (key) => {
    let n = 0
    if (authCache.has(`sync:${key}`)) n++
    for (const k of authCache.keys()) if (k.startsWith(`device:${key}:`)) n++
    return n
}

const dropAuthEntries = (key) => {
    const dropped = countAuthEntries(key)
    invalidateCachedAuth(`sync:${key}`)
    invalidateCachedAuthPrefix(`device:${key}:`)
    return dropped
}

const ownerRuleIds = async (key) => (await db.query('SELECT id FROM autopilot_rules WHERE owner_sync_user = $1', [key])).map((r) => String(r.id))

export function createRepairs({ log = console, autopilotEngine = null, reconciler = null } = {}) {

    // Cache resets only; zero DB writes, zero platform traffic.
    const REPAIRS = {
        'release-sync-lease': {
            async plan(key) {
                const syncResponse = peekSyncResponseCache(key) ? 1 : 0
                const cachedAuth = countAuthEntries(key)
                return {
                    scope: 'sync',
                    matchCount: syncResponse + cachedAuth,
                    summary: `${cachedAuth} cached sign-in entries and ${syncResponse} cached sync response(s) would be cleared. There is no server-side sync lease.`,
                    samples: [],
                }
            },
            async execute(key) {
                const cachedAuth = dropAuthEntries(key)
                return { syncResponseCache: invalidateSyncResponseCache(key), cachedAuth }
            },
            message: 'Cleared the sync server caches for this account.',
        },
        'clear-server-caches': {
            async plan(key) {
                const ruleIds = await ownerRuleIds(key)
                const rules = autopilotEngine?.invalidateRuleCaches ? await autopilotEngine.invalidateRuleCaches(ruleIds, { dry: true }) : { rules: 0, ruleDecrypt: 0 }
                const layers = {
                    connection: connectionCacheCountForOwner(key),
                    canonical: canonicalCacheCountForOwner(key),
                    rules: rules.rules,
                    ruleDecrypt: rules.ruleDecrypt,
                    syncResponse: peekSyncResponseCache(key) ? 1 : 0,
                    cachedAuth: countAuthEntries(key),
                }
                const total = Object.values(layers).reduce((a, b) => a + b, 0)
                const samples = Object.entries(layers).filter(([, n]) => n > 0).map(([name]) => name)
                const parts = Object.entries(layers).filter(([, n]) => n > 0).map((e) => e.join(' '))
                return { scope: 'server', matchCount: total, summary: `${total} cache entries would be cleared (${parts.join(', ')}). The addon health cache is shared and stays.`, samples }
            },
            async execute(key) {
                const ruleIds = await ownerRuleIds(key)
                const rules = autopilotEngine?.invalidateRuleCaches ? await autopilotEngine.invalidateRuleCaches(ruleIds) : { rules: 0, ruleDecrypt: 0 }
                return {
                    connection: dropConnectionCacheForOwner(key),
                    canonical: invalidateCanonicalForOwner(key),
                    rules: rules.rules,
                    ruleDecrypt: rules.ruleDecrypt,
                    syncResponse: invalidateSyncResponseCache(key),
                    cachedAuth: dropAuthEntries(key),
                }
            },
            message: "Cleared the server caches for this account. Some responses may be slower for a few minutes.",
        },
        'reset-activity-breaker': {
            async plan(key) {
                const summary = breakerSummaryForOwner(key)
                return {
                    scope: 'activity',
                    matchCount: summary.inBackoff,
                    summary: summary.inBackoff > 0
                        ? `${summary.inBackoff} connection(s) backing off, longest backoff ${Math.max(1, Math.round(summary.longestBackoffMs / 60000))} min.`
                        : '0 connections are backing off.',
                    samples: [],
                }
            },
            async execute(key) {
                return { cleared: resetBreakerForOwner(key) }
            },
            message: 'Reset the activity scan backoff for this account.',
        },
        'clear-login-backoff': {
            async plan(key) {
                if (!reconciler?.loginBackoffSummaryForOwner) return { scope: 'login', matchCount: 0, summary: 'The connection reconciler is not available.', samples: [] }
                const summary = await reconciler.loginBackoffSummaryForOwner(key)
                return {
                    scope: 'login',
                    matchCount: summary.entries,
                    summary: `${summary.entries} connection(s) in login backoff or auth cooldown would be cleared (${summary.authCooldown} auth cooldown, ${summary.backoff} backoff).`,
                    samples: [],
                }
            },
            async execute(key) {
                if (!reconciler?.resetLoginBackoffForOwner) throw new Error('The connection reconciler is not available.')
                return { cleared: await reconciler.resetLoginBackoffForOwner(key) }
            },
            message: 'Cleared the login backoff for this account.',
        },
    }

    const catalogKeys = new Set(REPAIR_CATALOG.map((r) => r.key))

    async function statusOf(key) {
        const row = await db.get('SELECT disabled_at, deleted_at FROM account_admin_state WHERE sync_user = $1', [key])
        if (!row) return 'active'
        if (row.deleted_at) return 'deleted'
        if (row.disabled_at) return 'disabled'
        return 'active'
    }

    // History is derived from the append-only audit chain; no new table. The LIKE
    // matches the serialized handle field, never a bare handle: JSON escaping turns
    // quotes inside a reason into backslash quotes, so a reason cannot forge the
    // field text and another account's runs cannot leak into this feed.
    async function history(handle) {
        if (!HANDLE_RE.test(String(handle))) return []
        const rows = await db.query('SELECT seq, ts, details FROM admin_audit WHERE event = $1 AND details LIKE $2 ORDER BY seq DESC LIMIT $3', ['repair.run', `%"handle":"${handle}"%`, HISTORY_LIMIT])
        return rows.map((r) => {
            let details = null
            try { details = r.details ? JSON.parse(r.details) : null } catch { details = null }
            return { seq: Number(r.seq), at: new Date(Number(r.ts)).toISOString(), repair: details?.repair ?? null, reason: details?.reason ?? null, counts: details?.counts ?? null }
        })
    }

    async function catalogAndHistory(reply, handle) {
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
        return { repairs: repairCatalogForStatus(await statusOf(resolved.key)), history: await history(handle) }
    }

    async function run(reply, handle, key, body, auditEntry) {
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
        const accountKey = resolved.key
        if (!AVAILABLE_REPAIRS.has(key)) {
            if (catalogKeys.has(key)) {
                reply.status(404)
                return { error: 'repair_unavailable', message: 'This repair is not available on this instance.' }
            }
            reply.status(404)
            return { error: 'Unknown repair key.' }
        }
        if (invalidReason(body?.reason)) {
            reply.status(400)
            return { error: 'A reason between 3 and 500 characters is required.' }
        }
        try {
            await assertAccountActive(accountKey)
        } catch (err) {
            if (err instanceof AuthStateError && err.state === 'deleted') {
                reply.status(409)
                return { error: 'account_deleted' }
            }
            if (!(err instanceof AuthStateError)) throw err
            // Disabled accounts may run repairs; only deleted is refused.
        }
        const spec = REPAIRS[key]
        if (body?.dryRun === true) {
            const plan = await spec.plan(accountKey)
            return { ...plan, userNotice: NOTICE_TEMPLATES[`repair.${key}`] || `repair.${key}` }
        }
        assertWritablePrimary()
        const counts = await spec.execute(accountKey)
        const now = Date.now()
        await auditedTx(
            (tx) => appendUserNotice(tx, accountKey, `repair.${key}`, now),
            () => ({ ...auditEntry, event: 'repair.run', details: { handle, repair: key, counts, reason: auditReason(body.reason) } })
        )
        log.info({ category: 'Dashboard' }, `Dashboard: repair ${key} run for ${handle} (${Object.entries(counts).map((e) => e.join('=')).join(' ') || 'no counts'}).`)
        return { ok: true, counts, message: spec.message }
    }

    return { run, catalogAndHistory, history }
}
