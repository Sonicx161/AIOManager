// Dashboard Settings: the env registry with one value per key, stored in the owner-less
// instance_settings table. Precedence is environment > stored > default; env-set and env-only
// keys are read-only here. Secrets are encrypted with the server key and never returned.
import db from '../db.js'
import { encrypt } from '../crypto.js'
import { PRIMARY_KEY } from '../keys.js'
import { adminReadOnly } from './config.js'
import { auditedTx } from './audit.js'
import { cachedRead } from './cached-read.js'
import { SETTING_GROUPS, SETTING_KEYS, checkSettingValue, settingSpec } from './settings-registry.js'
import { captureBootState, preloadedBootState } from '../lib/settings-boot.js'

export const SETTINGS_EXPORT_FORMAT = 'aiomanager-settings'
const MAX_CHANGES = 100
const AUDIT_VALUE_CHARS = 120
const AUDIT_BUDGET = 3600
const UPSERT = 'INSERT INTO instance_settings (setting_key, setting_value, is_secret, updated_at, updated_by_admin) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (setting_key) DO UPDATE SET setting_value = excluded.setting_value, is_secret = excluded.is_secret, updated_at = excluded.updated_at, updated_by_admin = excluded.updated_by_admin'

export class SettingsError extends Error {
    constructor(status, message, errors = null) {
        super(message)
        this.status = status
        this.errors = errors
    }
}

const nonEmpty = (v) => typeof v === 'string' && v !== ''
const clip = (v) => (v === null || v === undefined ? null : String(v).length > AUDIT_VALUE_CHARS ? `${String(v).slice(0, AUDIT_VALUE_CHARS)}...` : String(v))

// Keys first, then as many old/new pairs as fit the audit details budget.
function auditDetails(changes, extra = {}) {
    const details = { ...extra, keys: changes.map((c) => c.key).join(', '), changes: [] }
    let size = JSON.stringify(details).length
    for (const c of changes) {
        const entry = { key: c.key, from: c.auditFrom, to: c.auditTo }
        const add = JSON.stringify(entry).length + 1
        if (size + add > AUDIT_BUDGET) { details.more = changes.length - details.changes.length; break }
        details.changes.push(entry)
        size += add
    }
    if (details.keys.length > 1200) details.keys = `${details.keys.slice(0, 1200)}...`
    return details
}

export function createSettings({ log = null, logger = null, actor = () => 'admin', boot = preloadedBootState() || captureBootState(process.env) } = {}) {
    const changedSinceBoot = new Set()
    const fromEnv = (key) => boot.envKeys.has(key)

    async function readStore(q = db) {
        const rows = await q.query('SELECT setting_key, setting_value, is_secret, updated_at FROM instance_settings', [])
        const store = new Map()
        for (const r of rows) store.set(String(r.setting_key), { raw: r.setting_value, secret: Number(r.is_secret) === 1 || r.is_secret === true, updatedAt: Number(r.updated_at) || null })
        return store
    }
    // Reads share a short cache like the other Dashboard reads; every write resets it.
    const cachedStore = cachedRead(30_000, () => readStore(), { failTtlMs: 5_000 })

    function effective(spec, store) {
        if (spec.internal) return { source: 'internal', raw: process.env[spec.key] ?? null }
        if (fromEnv(spec.key)) return { source: 'env', raw: process.env[spec.key] }
        if (store.has(spec.key)) return { source: 'here', raw: spec.secret ? null : store.get(spec.key).raw }
        return { source: 'default', raw: spec.secret ? null : spec.default }
    }

    function restartPending(spec, eff, store) {
        if (spec.apply !== 'restart' || spec.envOnly || eff.source === 'env') return false
        if (spec.secret) return changedSinceBoot.has(spec.key)
        const now = eff.source === 'here' ? store.get(spec.key).raw : undefined
        return now !== boot.bootValues.get(spec.key)
    }

    function row(spec, store) {
        const eff = effective(spec, store)
        const out = {
            key: spec.key,
            label: spec.label,
            type: spec.type,
            summary: spec.summary,
            more: spec.more,
            source: eff.source,
            apply: spec.apply,
            envOnly: spec.envOnly,
            restartPending: restartPending(spec, eff, store),
            stored: store.has(spec.key),
        }
        // A valid save after boot replaces the value that was rejected at startup.
        const skipped = !changedSinceBoot.has(spec.key) && boot.skipped?.find((s) => s.key === spec.key)
        if (skipped) out.bootSkipped = skipped.reason
        if (spec.envOnly) out.envOnlyReason = spec.envOnlyReason
        if (spec.options) out.options = spec.options
        if (spec.min !== undefined) out.min = spec.min
        if (spec.max !== undefined) out.max = spec.max
        if (spec.unit) out.unit = spec.unit
        if (spec.secret) {
            out.set = eff.source === 'env' || eff.source === 'internal' ? nonEmpty(process.env[spec.key]) : eff.source === 'here'
            return out
        }
        out.value = eff.raw ?? null
        out.default = spec.default
        if (spec.defaultLabel) out.defaultLabel = spec.defaultLabel
        if (eff.source === 'env' && store.has(spec.key)) out.storedValue = store.get(spec.key).raw
        out.canAdopt = eff.source === 'env' && !spec.envOnly && !checkSettingValue(spec.key, eff.raw).error
        return out
    }

    async function view() {
        const store = await cachedStore()
        const groups = SETTING_GROUPS.map((g) => ({ id: g.id, title: g.title, note: g.note, rows: g.keys.map((k) => row(settingSpec(k), store)) }))
        return {
            precedence: ['env', 'here', 'default'],
            groups,
            readOnly: adminReadOnly(),
            bootReadFailed: Boolean(boot.readFailed),
            bootLiveReapplied: Boolean(boot.liveReapply?.ok),
            restartPending: groups.flatMap((g) => g.rows).filter((r) => r.restartPending).length,
            computedAt: Date.now(),
        }
    }

    // Live keys follow the store at once; the next boot does the same for restart keys.
    function applyLive(spec, plain) {
        if (spec.apply !== 'live' || fromEnv(spec.key)) return
        if (plain === null) delete process.env[spec.key]
        else process.env[spec.key] = plain
        if (spec.key === 'LOG_LEVEL' && logger) {
            try { logger.level = process.env.LOG_LEVEL || spec.default } catch { /* keep the running level */ }
        }
    }

    function assertWritable() {
        if (adminReadOnly()) throw new SettingsError(403, 'Settings cannot be changed on a read-only replica. Change them on the primary.')
    }

    function describe(spec, store, next) {
        const had = store.get(spec.key)
        if (spec.secret) {
            return { auditFrom: had ? 'set' : 'not set', auditTo: next === null ? 'default' : 'replaced', from: had ? 'Set' : 'Not set', to: next === null ? 'Not set' : 'Replaced' }
        }
        const from = had ? had.raw : null
        return { auditFrom: clip(from ?? 'default'), auditTo: clip(next ?? 'default'), from, to: next }
    }

    // The batch and its audit entry are one transaction; live keys switch over only after it commits.
    async function write(changes, event, ctx, extra) {
        const now = Date.now()
        const who = String(actor() || 'admin').slice(0, 64)
        await auditedTx(async (tx) => {
            for (const c of changes) {
                if (c.next === null) await tx.run('DELETE FROM instance_settings WHERE setting_key = $1', [c.spec.key])
                else await tx.run(UPSERT, [c.spec.key, c.spec.secret ? encrypt(c.next, PRIMARY_KEY) : c.next, c.spec.secret ? 1 : 0, now, who])
            }
        }, () => ({ ...ctx, event, details: auditDetails(changes, extra) }))
        cachedStore.reset()
        for (const c of changes) {
            changedSinceBoot.add(c.spec.key)
            applyLive(c.spec, c.next)
        }
    }

    async function save(input, ctx = {}) {
        assertWritable()
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SettingsError(400, 'Send the changed settings as an object of key to value.')
        const entries = Object.entries(input)
        if (!entries.length) throw new SettingsError(400, 'Nothing to save.')
        if (entries.length > MAX_CHANGES) throw new SettingsError(400, `Save at most ${MAX_CHANGES} settings at once.`)
        const store = await readStore()
        const errors = Object.create(null)
        const changes = []
        for (const [key, value] of entries) {
            const spec = settingSpec(key)
            if (!spec) { errors[key] = 'Unknown setting.'; continue }
            if (spec.envOnly) { errors[key] = 'Set in .env only.'; continue }
            if (fromEnv(key)) { errors[key] = 'Set in .env. Remove it there to change it here.'; continue }
            if (value === null) {
                if (store.has(key)) changes.push({ spec, next: null })
                continue
            }
            const checked = checkSettingValue(key, value)
            if (checked.error) { errors[key] = checked.error; continue }
            if (!spec.secret && store.get(key)?.raw === checked.value) continue
            changes.push({ spec, next: checked.value })
        }
        if (Object.keys(errors).length) throw new SettingsError(400, 'Some settings are not valid. Nothing was saved.', errors)
        const described = changes.map((c) => ({ ...c, key: c.spec.key, ...describe(c.spec, store, c.next) }))
        if (described.length) {
            await write(described, 'settings.update', ctx)
        }
        return { ok: true, saved: described.length, restartNeeded: described.filter((c) => c.spec.apply === 'restart').map((c) => c.key) }
    }

    async function adopt(keys, ctx = {}) {
        assertWritable()
        if (!Array.isArray(keys) || !keys.length || keys.length > MAX_CHANGES) throw new SettingsError(400, 'Send the keys to copy as a list.')
        const store = await readStore()
        const errors = Object.create(null)
        const changes = []
        for (const key of keys) {
            const spec = typeof key === 'string' ? settingSpec(key) : null
            if (!spec) { errors[String(key)] = 'Unknown setting.'; continue }
            if (spec.envOnly) { errors[key] = 'Set in .env only.'; continue }
            if (spec.secret) { errors[key] = 'Secrets stay in .env.'; continue }
            if (!fromEnv(key)) { errors[key] = 'Not set in .env.'; continue }
            const checked = checkSettingValue(key, process.env[key])
            if (checked.error) { errors[key] = `The .env value cannot be stored here. ${checked.error}`; continue }
            if (store.get(key)?.raw === checked.value) continue
            changes.push({ spec, next: checked.value, key, ...describe(spec, store, checked.value) })
        }
        if (Object.keys(errors).length) throw new SettingsError(400, 'Some settings cannot be copied. Nothing was saved.', errors)
        if (changes.length) {
            await write(changes, 'settings.adopt', ctx)
        }
        return { ok: true, copied: changes.length }
    }

    async function exportValues() {
        const store = await cachedStore()
        const values = {}
        const secretsLeftOut = []
        for (const key of SETTING_KEYS) {
            const spec = settingSpec(key)
            const eff = effective(spec, store)
            if (spec.secret) {
                if (eff.source === 'here' || nonEmpty(process.env[key])) secretsLeftOut.push(key)
                continue
            }
            if (spec.envOnly || spec.internal) continue
            // null marks a key at its default, so importing the file restores it there.
            values[key] = eff.source === 'default' ? null : eff.raw
        }
        return { format: SETTINGS_EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), values, secretsLeftOut }
    }

    async function importValues(input, { apply = false } = {}, ctx = {}) {
        if (apply) assertWritable()
        const values = input && typeof input === 'object' && !Array.isArray(input) && input.values && typeof input.values === 'object' ? input.values : input
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new SettingsError(400, 'The file is not a settings export.')
        const entries = Object.entries(values)
        if (entries.length > 200) throw new SettingsError(400, 'The file has too many settings.')
        const store = await readStore()
        const changes = []
        const rejected = []
        const skipped = []
        for (const [key, value] of entries) {
            const spec = settingSpec(key)
            if (!spec) { rejected.push({ key, error: 'Unknown setting.' }); continue }
            const base = { key, label: spec.label }
            if (spec.envOnly) { skipped.push({ ...base, reason: 'Set in .env only' }); continue }
            if (spec.secret) { skipped.push({ ...base, reason: 'Secrets are never imported' }); continue }
            if (fromEnv(key)) { skipped.push({ ...base, reason: 'Set in .env' }); continue }
            if (value === null) {
                if (!store.has(key)) { skipped.push({ ...base, reason: 'Unchanged' }); continue }
                changes.push({ spec, next: null, key, label: spec.label, apply: spec.apply, ...describe(spec, store, null), from: effective(spec, store).raw })
                continue
            }
            const checked = checkSettingValue(key, value)
            if (checked.error) { rejected.push({ ...base, error: checked.error }); continue }
            const current = effective(spec, store).raw
            if (current === checked.value) { skipped.push({ ...base, reason: 'Unchanged' }); continue }
            changes.push({ spec, next: checked.value, key, label: spec.label, apply: spec.apply, ...describe(spec, store, checked.value), from: current })
        }
        if (apply && changes.length) {
            await write(changes, 'settings.import', ctx, { rejected: rejected.length, skipped: skipped.length })
        }
        return {
            ok: true,
            applied: apply ? changes.length : 0,
            changes: changes.map((c) => ({ key: c.key, label: c.label, from: c.from, to: c.next, apply: c.apply })),
            rejected,
            skipped,
        }
    }

    if (log && boot.skipped?.length) log.warn({ category: 'Dashboard' }, `Settings: ${boot.skipped.length} stored value(s) were skipped at boot: ${boot.skipped.map((s) => s.key).join(', ')}.`)

    return { view, save, adopt, exportValues, importValues, readStore }
}
