import { autopilotDb as db } from '../write-tripwire.js'
import { normalizeAddonUrl } from '../../utils/addon-url.js'
import { decrypt } from '../../crypto.js'
import { FALLBACK_KEYS } from '../../keys.js'
import { maskContext } from '../../utils/log-helpers.js'

export function createSiblings({ fastify, decryptRuleField, cycleTargets, conflicts = null }) {
    // Sibling chains of the same account: chain membership is stable (only the active member
    // moves), so reading it from the rule rows is safe; the sibling's *target* is read from
    // the current cycle first (a rule persists active_url only after the whole account batch,
    // so the DB value is one cycle stale exactly when two chains fail over together) and from
    // the persisted row second.
    // Lifecycle: an entry is an UNCOMMITTED decision, nothing more. siblingChainPlans honors
    // it only while the rule row still looks exactly as it did when the decision was recorded
    // (same persisted active_url AND same updated_at). The engine's own batch commit bumps
    // updated_at, and so does every manual writer (routes upsert), so both retire the entry
    // and the fresh row wins. Cycle boundaries also clear entries, including when a batch
    // commit fails and therefore leaves the row version unchanged.

    const parseChainValue = (raw, row = null) => {
        const decrypted = row ? decryptRuleField(row, 'priority_chain') : decrypt(raw, FALLBACK_KEYS)
        let parsed = []
        try {
            if (Array.isArray(decrypted)) parsed = decrypted
            else if (typeof decrypted === 'string' && decrypted.startsWith('[')) parsed = JSON.parse(decrypted)
            else if (typeof raw === 'string' && raw.startsWith('[')) parsed = JSON.parse(raw)
        } catch { }
        return Array.isArray(parsed) ? parsed : []
    }

    // One plan per sibling rule: the chain members another rule owns, plus that chain's target.
    const siblingKey = (owner, accountId) => `${owner || ''}\0${accountId ?? ''}`

    // A rule's chain and active url are fixed per (id, updated_at), so the per-cycle sibling read fetches versions and loads those two columns once per version.
    // The bound counts the UTF-8 bytes of the two held columns plus a fixed overhead per rule: an estimate of held payload, not of process memory.
    const SIBLING_FIELDS_MAX_BYTES = 64 * 1024 * 1024
    const SIBLING_FIELDS_READ_CHUNK = 500
    const SIBLING_ENTRY_OVERHEAD_BYTES = 256
    const siblingFields = new Map()
    let siblingFieldBytes = 0
    const dropSiblingFields = (id) => {
        const held = siblingFields.get(id)
        if (!held) return
        siblingFields.delete(id)
        siblingFieldBytes -= held.bytes
    }
    const textBytes = (value) => (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0)
    const sameRule = (fields, head) => fields.updated_at === head.updated_at
        && fields.account_id === head.account_id
        && (fields.owner_sync_user || '') === (head.owner_sync_user || '')
    // Returns null when a row no longer is the rule the head read saw (deleted, id reused, or changed in between).
    const siblingFieldsFor = async (heads) => {
        const found = new Map()
        const missing = new Map()
        for (const head of heads) {
            const held = head.updated_at == null ? null : siblingFields.get(head.id)
            if (held && sameRule(held, head)) {
                siblingFields.delete(head.id)
                siblingFields.set(head.id, held)
                found.set(head.id, held)
            } else {
                missing.set(head.id, head)
            }
        }
        const ids = [...missing.keys()]
        for (let i = 0; i < ids.length; i += SIBLING_FIELDS_READ_CHUNK) {
            const chunk = ids.slice(i, i + SIBLING_FIELDS_READ_CHUNK)
            const rows = await db.query(
                `SELECT id, account_id, owner_sync_user, priority_chain, active_url, updated_at FROM autopilot_rules WHERE id IN (${chunk.map((_, j) => `$${j + 1}`).join(',')})`,
                chunk
            )
            for (const row of rows || []) {
                const head = missing.get(row.id)
                if (!head || !sameRule(row, head)) return null
                const entry = {
                    account_id: row.account_id, owner_sync_user: row.owner_sync_user,
                    priority_chain: row.priority_chain, active_url: row.active_url, updated_at: row.updated_at,
                    bytes: SIBLING_ENTRY_OVERHEAD_BYTES + textBytes(row.priority_chain) + textBytes(row.active_url),
                }
                found.set(row.id, entry)
                dropSiblingFields(row.id)
                if (row.updated_at == null || entry.bytes > SIBLING_FIELDS_MAX_BYTES) continue
                while (siblingFieldBytes + entry.bytes > SIBLING_FIELDS_MAX_BYTES && siblingFields.size > 0) dropSiblingFields(siblingFields.keys().next().value)
                siblingFields.set(row.id, entry)
                siblingFieldBytes += entry.bytes
            }
        }
        return found.size === heads.length ? found : null
    }

    // One query per chunk replaces one sibling read per rule. Only accounts where one owner
    // holds 2+ active rules return rows; every requested owner+account pair gets an entry, so
    // an empty array means "no siblings" and a missing key means "not prefetched".
    // Owner-less legacy rows are never siblings (they match only by their own rule id), so a
    // legacy rule's pair stays empty instead of pooling every owner-less rule of the account.
    // The unary plus keeps SQLite on the account index for the sibling probe; Postgres keeps its active-rule index.
    const prefetchSiblingRows = async (rules) => {
        const pairs = new Map()
        for (const rule of rules) pairs.set(siblingKey(rule.owner_sync_user, rule.account_id), [])
        const accountIds = [...new Set(rules.map(r => r.account_id).filter(Boolean))]
        if (accountIds.length === 0) return pairs
        const owners = [...new Set(rules.map(r => r.owner_sync_user || ''))]
        const accountPh = accountIds.map((_, i) => `$${i + 1}`).join(',')
        const ownerPh = owners.map((_, i) => `$${accountIds.length + i + 1}`).join(',')
        const activeProbe = db.type === 'postgres' ? 'o.is_active = 1' : '+o.is_active = 1'
        const scopedRead = (columns) => db.query(
            `SELECT ${columns}
             FROM autopilot_rules r
             WHERE r.account_id IN (${accountPh}) AND COALESCE(r.owner_sync_user, '') IN (${ownerPh}) AND COALESCE(r.owner_sync_user, '') <> '' AND r.is_active = 1
             AND EXISTS (
                SELECT 1 FROM autopilot_rules o
                WHERE o.account_id = r.account_id AND COALESCE(o.owner_sync_user, '') = COALESCE(r.owner_sync_user, '')
                AND ${activeProbe} AND o.id <> r.id
             )`,
            [...accountIds, ...owners]
        )
        try {
            const heads = (await scopedRead('r.id, r.account_id, r.owner_sync_user, r.updated_at')) || []
            const fieldsById = await siblingFieldsFor(heads)
            if (fieldsById) {
                for (const head of heads) {
                    const fields = fieldsById.get(head.id)
                    pairs.get(siblingKey(head.owner_sync_user, head.account_id))?.push({
                        id: head.id, account_id: head.account_id, owner_sync_user: head.owner_sync_user,
                        priority_chain: fields.priority_chain, active_url: fields.active_url, updated_at: fields.updated_at,
                    })
                }
                return pairs
            }
            // The two reads disagreed about a rule: take everything from one scoped read instead.
            const rows = await scopedRead('r.id, r.account_id, r.owner_sync_user, r.priority_chain, r.active_url, r.updated_at')
            for (const row of rows || []) pairs.get(siblingKey(row.owner_sync_user, row.account_id))?.push(row)
            return pairs
        } catch (err) {
            fastify.log.warn({ category: 'Autopilot' }, `Batched sibling chain read failed, using per-rule reads: ${err.message}`)
            return null
        }
    }

    // account_id is not an auth boundary: siblings must share the owning sync user. An
    // undefined owner is resolved from the rule id; if it cannot be resolved nothing is read.
    // An owner-less legacy rule is ambiguous across tenants and gets no siblings.
    // prefetchedRows (from prefetchSiblingRows) replaces the per-rule read when supplied.
    const siblingChainPlans = async (accountId, ownRuleId, ownChain, ownerSyncUser, prefetchedRows = null) => {
        const own = new Set((ownChain || []).map(u => normalizeAddonUrl(u).toLowerCase()))
        let rows = []
        let resolvedOwner = ownerSyncUser
        try {
            if (Array.isArray(prefetchedRows)) {
                rows = prefetchedRows.filter(row => row.id !== ownRuleId && (row.account_id === undefined || row.account_id === accountId) && (row.owner_sync_user === undefined || row.owner_sync_user === ownerSyncUser))
            } else {
                let owner = ownerSyncUser
                if (owner === undefined) {
                    owner = (await db.get('SELECT owner_sync_user FROM autopilot_rules WHERE id = $1 AND account_id = $2', [ownRuleId, accountId]))?.owner_sync_user
                    if (owner === undefined) return []
                }
                if (!owner) return []
                resolvedOwner = owner
                rows = await db.query(
                    `SELECT id, priority_chain, active_url, updated_at FROM autopilot_rules
                     WHERE account_id = $1 AND COALESCE(owner_sync_user, '') = $2 AND is_active = 1 AND id <> $3`,
                    [accountId, owner || '', ownRuleId]
                )
            }
        } catch (err) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Sibling chain read failed: ${err.message}`)
            return Object.defineProperty([], 'readFailed', { value: true })
        }
        const plans = []
        const chains = (rows || []).map(row => ({ row, urls: [...new Set(parseChainValue(row.priority_chain, row).map(normalizeAddonUrl).filter(Boolean))] }))
        if (chains.some(({ row, urls }) => row.priority_chain && urls.length === 0)) return Object.defineProperty([], 'readFailed', { value: true })
        const counts = new Map([...own].map(url => [url, 1]))
        for (const { urls } of chains) for (const url of urls) counts.set(url, (counts.get(url) || 0) + 1)
        const contested = new Set([...counts].filter(([, count]) => count > 1).map(([url]) => url))
        const protectedUrls = new Set([...contested, ...(conflicts?.getAccountProtectedUrls(accountId, resolvedOwner) || []), ...(conflicts?.getHold(ownRuleId)?.urls || [])])
        const candidates = chains.map(({ row, urls: fullChain }) => {
            const persisted = normalizeAddonUrl(decryptRuleField(row, 'active_url') || row.active_url || '').toLowerCase()
            // An uncommitted in-cycle decision outranks the row, but only while the row is
            // still untouched since that decision was recorded (same persisted value, same
            // updated_at). Our own batch commit and any manual writer both bump updated_at,
            // which retires the entry; otherwise a decision recorded in an old cycle would
            // keep overriding a manual active_url change that landed between cycles.
            const decision = cycleTargets.get(row.id)
            const decided = decision
                && decision.persisted === persisted
                && (decision.updatedAt == null || decision.updatedAt === row.updated_at)
                && fullChain.includes(decision.target)
                ? decision.target
                : null
            const target = decided ?? (fullChain.includes(persisted) ? persisted : null)
            return { row, fullChain, target }
        })
        // A skipped sibling owns its whole live chain, including its unshared members.
        // Expand until stable when preserving one chain also protects another's target.
        let expanded
        do {
            expanded = false
            for (const { fullChain, target } of candidates) {
                if (target && !protectedUrls.has(target)) continue
                for (const url of fullChain) {
                    if (protectedUrls.has(url)) continue
                    protectedUrls.add(url)
                    expanded = true
                }
            }
        } while (expanded)
        Object.defineProperties(plans, {
            contestedUrls: { value: [...protectedUrls] },
            overlapUrls: { value: [...own].filter(url => contested.has(url)) },
            sourceRows: { value: rows },
        })
        for (const { row, fullChain, target } of candidates) {
            if (!target || protectedUrls.has(target)) continue
            const urls = fullChain.filter(url => !protectedUrls.has(url))
            if (urls.length === 0) continue
            plans.push({ ruleId: row.id, urls, target })
        }
        return plans
    }

    return { parseChainValue, siblingKey, prefetchSiblingRows, siblingChainPlans }
}
