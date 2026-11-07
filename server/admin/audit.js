import crypto from 'crypto'
import db from '../db.js'
import { adminReadOnly } from './config.js'
import { redactAddressesStrict } from './redact-ip.js'
import { auditSettingChange } from './settings-registry.js'

export const GENESIS_HASH = '0'.repeat(64)
const MAX_DETAILS_BYTES = 4096

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

export function canonicalAuditRow(row) {
    return JSON.stringify([
        Number(row.seq), Number(row.ts), String(row.event), String(row.actor),
        row.ip_prefix ?? null, row.ua_hash ?? null, String(row.result), row.details ?? null,
    ])
}

export const auditRowHash = (prevHash, row) => sha256(`${prevHash}|${canonicalAuditRow(row)}`)

function encodeDetails(details) {
    if (details == null) return null
    const json = JSON.stringify(details)
    return json.length > MAX_DETAILS_BYTES ? JSON.stringify({ truncated: true }) : json
}

let chain = Promise.resolve()

async function insertAuditRow(tx, { event, result = 'ok', ipPrefix = null, uaHash = null, uaFamily = null, details = null, actor = 'admin', now = Date.now() }) {
    const last = await tx.get('SELECT seq, row_hash FROM admin_audit ORDER BY seq DESC LIMIT 1', [])
    // ip_prefix stays a stored column for the operator's own security; the device label is
    // the only client-facing origin hint, so it rides inside the hashed details JSON.
    const withDevice = uaFamily && uaFamily !== 'Unknown' ? { device: String(uaFamily), ...(details || {}) } : details
    const row = {
        seq: last ? Number(last.seq) + 1 : 1,
        ts: now,
        event: String(event),
        actor: String(actor),
        ip_prefix: ipPrefix,
        ua_hash: uaHash,
        result: String(result),
        details: encodeDetails(withDevice),
    }
    const prevHash = last?.row_hash || GENESIS_HASH
    const rowHash = auditRowHash(prevHash, row)
    await tx.run(
        'INSERT INTO admin_audit (seq, ts, event, actor, ip_prefix, ua_hash, result, details, prev_hash, row_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [row.seq, row.ts, row.event, row.actor, row.ip_prefix, row.ua_hash, row.result, row.details, prevHash, rowHash]
    )
    return { seq: row.seq, rowHash }
}

function serialized(run) {
    const next = chain.then(run, run)
    chain = next.catch(() => {})
    return next
}

// Appends are serialized in-process; the seq primary key rejects a concurrent writer
// elsewhere, which surfaces as a failed append instead of a forked chain.
export function appendAudit(entry) {
    if (adminReadOnly()) return Promise.resolve({ skipped: true })
    return serialized(() => db.tx((tx) => insertAuditRow(tx, entry)))
}

// Runs fn(tx) and its audit entry in one transaction: if either fails, neither is written.
// An entryFor that returns null commits the action without an audit row (idempotent
// repeats must not append). txOpts pass through to db.tx (isolation for the bulk
// confirm, immediate mode on sqlite).
export function auditedTx(fn, entryFor, { txOpts = null } = {}) {
    if (adminReadOnly()) return Promise.reject(new Error('The audit log is read-only on a replica.'))
    return serialized(() => db.tx(async (tx) => {
        const result = await fn(tx)
        const entry = entryFor(result)
        if (entry) await insertAuditRow(tx, entry)
        return result
    }, txOpts || undefined))
}

const ACTION_LABELS = {
    'login.success': 'Sign-in succeeded',
    'login.fail': 'Sign-in failed',
    'login.lock_ip': 'Address locked out',
    'login.lock_global': 'Sign-in locked for everyone',
    'login.unlock': 'Sign-in locks cleared',
    'setup.complete': 'Dashboard set up',
    'setup.fail': 'Setup token rejected',
    logout: 'Signed out',
    'session.revoke': 'Session revoked',
    'session.revoke_all': 'All sessions revoked',
    'settings.update': 'Settings changed',
    'settings.adopt': 'Settings copied from .env',
    'settings.import': 'Settings imported',
    'logs.export': 'Logs exported',
    'account.disable': 'Account disabled',
    'account.enable': 'Account enabled',
    'account.delete': 'Account soft deleted',
    'account.restore': 'Account restored',
    'account.signout_devices': 'Devices signed out',
    'account.bulk_delete': 'Bulk soft delete',
    'repair.run': 'Repair run',
}

export const auditActionLabel = (event) => ACTION_LABELS[event] || String(event)

function auditDetail(row, details) {
    const parts = []
    // Every fragment crosses the wire through the strict address sanitizer (no version
    // exemption here: audit values are operator-controlled); stored JSON and row hashes
    // stay byte-identical.
    const push = (text) => parts.push(redactAddressesStrict(text))
    if (row.actor && row.actor !== 'admin') push(`by ${row.actor}`)
    if (details && typeof details === 'object') {
        // Settings saves list each key with its old and new value, but only registry
        // keys with a closed value type (boolean, enum, integer/duration) may show
        // them; every other key (strings, URLs, secrets, unknown legacy keys) reads
        // "changed", no values, under its canonical key.
        if (Array.isArray(details.changes)) {
            const scalar = (v) => v === null || v === undefined || typeof v !== 'object'
            for (const c of details.changes) {
                const { key, showValues } = auditSettingChange(c?.key)
                const label = key ?? String(c?.key)
                push(showValues && scalar(c?.from) && scalar(c?.to) ? `${label}: ${c?.from} -> ${c?.to}` : `${label}: changed`)
            }
            if (details.more) push(`${details.more} more`)
        }
        for (const [k, v] of Object.entries(details)) {
            if (k === 'keys' && Array.isArray(details.changes)) continue
            if (k === 'more' && Array.isArray(details.changes)) continue
            if (k === 'device') { if (typeof v === 'string' && v) push(v); continue }
            if (v === null || v === undefined || typeof v === 'object') continue
            push(k === 'until' && Number.isFinite(v) ? `until ${new Date(v).toISOString()}` : `${k} ${v}`)
        }
    }
    if (row.result && row.result !== 'ok') push(row.result)
    return parts.join(', ')
}

// Rows carry machine fields (seq, event, result) and display fields (action, detail).
export async function listAudit({ before = null, limit = 50 } = {}) {
    const size = Math.max(1, Math.min(200, Number(limit) || 50))
    const rows = before
        ? await db.query('SELECT seq, ts, event, actor, ip_prefix, result, details, prev_hash, row_hash FROM admin_audit WHERE seq < $1 ORDER BY seq DESC LIMIT $2', [Number(before), size])
        : await db.query('SELECT seq, ts, event, actor, ip_prefix, result, details, prev_hash, row_hash FROM admin_audit ORDER BY seq DESC LIMIT $1', [size])
    const out = rows.map((r) => {
        let details = null
        try { details = r.details ? JSON.parse(r.details) : null } catch { details = null }
        return {
            seq: Number(r.seq),
            at: new Date(Number(r.ts)).toISOString(),
            event: redactAddressesStrict(r.event),
            action: redactAddressesStrict(auditActionLabel(r.event)),
            detail: auditDetail(r, details),
            result: redactAddressesStrict(r.result),
            actor: redactAddressesStrict(r.actor),
            device: details && typeof details === 'object' && typeof details.device === 'string' ? redactAddressesStrict(details.device) : null,
            hash: r.row_hash,
            prevHash: r.prev_hash,
        }
    })
    const cursor = out.length === size ? String(out[out.length - 1].seq) : null
    return { rows: out, cursor }
}

// Walks the whole chain in pages. Detects edited rows, deleted middle rows and seq gaps.
export async function verifyAuditChain({ pageSize = 500 } = {}) {
    let prevHash = GENESIS_HASH
    let expectedSeq = 1
    let checked = 0
    for (;;) {
        const rows = await db.query(
            'SELECT seq, ts, event, actor, ip_prefix, ua_hash, result, details, prev_hash, row_hash FROM admin_audit WHERE seq >= $1 ORDER BY seq ASC LIMIT $2',
            [expectedSeq, pageSize]
        )
        for (const row of rows) {
            const seq = Number(row.seq)
            if (seq !== expectedSeq) return { ok: false, checked, brokenAt: expectedSeq, reason: 'gap' }
            if (row.prev_hash !== prevHash) return { ok: false, checked, brokenAt: seq, reason: 'link' }
            if (auditRowHash(prevHash, row) !== row.row_hash) return { ok: false, checked, brokenAt: seq, reason: 'hash' }
            prevHash = row.row_hash
            expectedSeq = seq + 1
            checked++
        }
        if (rows.length < pageSize) break
    }
    return { ok: true, checked, head: checked ? prevHash : null }
}
