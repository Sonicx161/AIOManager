import { AsyncLocalStorage } from 'node:async_hooks'
import rawDb from '../db.js'
import { guardedFetch } from '../utils/safe-fetch.js'

// Last-resort guard against an Autopilot write loop (the 2026 TOAST incident). Every statement the engine issues
// goes through autopilotDb; engine writes to the Autopilot tables are counted over a rolling hour. Crossing the
// limit enters safe mode: no DB writes, provider pushes or webhooks until the process restarts. User-initiated
// writes (rule saves and the echo they trigger) are charged to a per-owner budget instead, so one user can only
// rate-limit themselves, never the instance. Holds no DB state.

const HOUR_MS = 60 * 60 * 1000
const BUCKET_MS = 60 * 1000
const REMINDER_MS = 15 * 60 * 1000
const MB = 1024 * 1024

// Derivation behind the 0 (auto) defaults; the arithmetic is documented on the env vars in lib/env.js.
export const TRIPWIRE_DEFAULTS = Object.freeze({
    statementFloor: 600,
    statementsPerRule: 20,
    byteFloor: 50 * MB,
    bytesPerRule: 1 * MB,
})

export const OWNER_BUDGET_DEFAULTS = Object.freeze({
    statementsPerHour: 300,
    addonListBytesPerHour: 32 * MB,
    maxOwners: 10000,
})
const OWNER_BUCKET_MS = 5 * 60 * 1000

const FALSY = new Set(['0', 'false', 'no', 'off'])
const WATCHED_TABLES = /\b(autopilot_rules|autopilot_rule_stats|failover_history)\b/i
const LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\()+/
const READ_VERB = /^(select|explain|show|values)\b/i
const CTE_WRITE = /\b(insert|update|delete|merge)\b/i

export class AutopilotSafeModeError extends Error {
    constructor() {
        super('Autopilot is in write safe mode')
        this.name = 'AutopilotSafeModeError'
        this.code = 'autopilot-safe-mode'
    }
}

// Deny by default: anything that is not a plain read counts as a write.
export const classifyStatement = (sql) => {
    const text = String(sql ?? '').replace(LEADING_NOISE, '')
    let write = true
    if (READ_VERB.test(text)) write = false
    else if (/^with\b/i.test(text)) write = CTE_WRITE.test(text)
    else if (/^pragma\b/i.test(text)) write = text.includes('=')
    if (!write) return null
    return { watched: WATCHED_TABLES.test(text), addonList: /\baddon_list\b/i.test(text) }
}

export const paramBytes = (params) => {
    if (!Array.isArray(params)) return 0
    let total = 0
    for (const p of params) {
        if (p === null || p === undefined) continue
        if (typeof p === 'string') total += Buffer.byteLength(p)
        else if (ArrayBuffer.isView(p)) total += p.byteLength
        else if (typeof p === 'object') total += Buffer.byteLength(JSON.stringify(p) ?? '')
        else total += 8
    }
    return total
}

const positiveInt = (raw) => {
    const n = parseInt(raw ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : 0
}

const tripwireEnabled = (env) => !FALSY.has(String(env.AUTOPILOT_WRITE_TRIPWIRE ?? '').trim().toLowerCase())

const readConfig = (env) => ({
    enabled: tripwireEnabled(env),
    statementsPerHour: positiveInt(env.AUTOPILOT_WRITE_TRIPWIRE_PER_HOUR),
    bytesPerHour: positiveInt(env.AUTOPILOT_WRITE_TRIPWIRE_BYTES_PER_HOUR),
    webhookUrl: String(env.AUTOPILOT_TRIPWIRE_WEBHOOK_URL ?? '').trim() || null,
})

const defaultAlertFetch = (url, init) => guardedFetch(url, { ...init, discardBody: true, totalTimeoutMs: 10000 })

export function createWriteTripwire({ env = process.env, now = () => Date.now(), fetch: alertFetch = defaultAlertFetch, logger = console } = {}) {
    let config = null
    const cfg = () => (config ??= readConfig(env))
    let log = logger
    const buckets = []
    const totals = { statements: 0, bytes: 0, addonListWrites: 0, addonListBytes: 0 }
    const rulesSeen = new Map()
    let lastRulePrune = 0
    let safeMode = null
    let lastReminder = 0
    let alerts = 0

    const bucketFor = (t) => {
        while (buckets.length > 0 && t - buckets[0].start >= HOUR_MS) {
            const old = buckets.shift()
            for (const key of Object.keys(totals)) totals[key] -= old[key]
        }
        const start = t - (t % BUCKET_MS)
        let bucket = buckets[buckets.length - 1]
        if (!bucket || bucket.start !== start) {
            bucket = { start, statements: 0, bytes: 0, addonListWrites: 0, addonListBytes: 0 }
            buckets.push(bucket)
        }
        return bucket
    }

    const limits = () => {
        const active = rulesSeen.size
        return {
            statements: cfg().statementsPerHour || Math.max(TRIPWIRE_DEFAULTS.statementFloor, active * TRIPWIRE_DEFAULTS.statementsPerRule),
            bytes: cfg().bytesPerHour || Math.max(TRIPWIRE_DEFAULTS.byteFloor, active * TRIPWIRE_DEFAULTS.bytesPerRule),
        }
    }

    const sendAlert = () => {
        const url = cfg().webhookUrl
        if (!url || alerts > 0) return
        alerts++
        const text = `AIOManager Autopilot write tripwire tripped (${safeMode.reason}): ${safeMode.statements} statements, ${safeMode.bytes} bytes in the last hour. Autopilot stopped writing and kept every user's current addons. Restart the server after investigating to resume.`
        const body = JSON.stringify({ source: 'AIOManager Autopilot', type: 'write_tripwire', reason: safeMode.reason, since: new Date(safeMode.since).toISOString(), statements: safeMode.statements, bytes: safeMode.bytes, content: text, text })
        Promise.resolve()
            .then(() => alertFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }, body }))
            .catch(err => log.warn({ category: 'Autopilot' }, `Write tripwire alert failed: ${err?.code || 'request-failed'}`))
    }

    const trip = (reason, t, limit) => {
        safeMode = { since: t, reason, ...totals, limits: limit }
        lastReminder = t
        log.error({ category: 'Autopilot' }, `Write tripwire tripped (${reason}): ${totals.statements} statements (limit ${limit.statements}), ${totals.bytes} bytes (limit ${limit.bytes}) in the last hour across ${rulesSeen.size} active rule(s). Safe mode: no DB writes, provider pushes, swaps or webhooks until restart.`)
        sendAlert()
    }

    const remind = () => {
        if (!safeMode) return
        const t = now()
        if (t - lastReminder < REMINDER_MS) return
        lastReminder = t
        log.warn({ category: 'Autopilot' }, `Autopilot write safe mode active since ${new Date(safeMode.since).toISOString()} (${safeMode.reason}); writes, pushes and webhooks stay off until restart.`)
    }

    // Returns an error when the statement must not run.
    const checkStatement = (sql, params) => {
        if (!cfg().enabled) return null
        const kind = classifyStatement(sql)
        if (!kind) return null
        if (safeMode) {
            remind()
            return new AutopilotSafeModeError()
        }
        if (!kind.watched) return null
        const t = now()
        const bytes = paramBytes(params)
        const bucket = bucketFor(t)
        bucket.statements++
        totals.statements++
        bucket.bytes += bytes
        totals.bytes += bytes
        if (kind.addonList) {
            bucket.addonListWrites++
            totals.addonListWrites++
            bucket.addonListBytes += bytes
            totals.addonListBytes += bytes
        }
        const limit = limits()
        if (totals.statements > limit.statements) trip('statements', t, limit)
        else if (totals.bytes > limit.bytes) trip('bytes', t, limit)
        return safeMode ? new AutopilotSafeModeError() : null
    }

    const assertWritable = () => {
        if (!cfg().enabled || !safeMode) return
        remind()
        throw new AutopilotSafeModeError()
    }

    const noteRule = (id) => {
        if (!cfg().enabled || id === null || id === undefined) return
        const t = now()
        rulesSeen.delete(id)
        rulesSeen.set(id, t)
        if (t - lastRulePrune < BUCKET_MS) return
        lastRulePrune = t
        for (const [key, seen] of rulesSeen) {
            if (t - seen < HOUR_MS) break
            rulesSeen.delete(key)
        }
    }

    return {
        checkStatement,
        assertWritable,
        noteRule,
        remind,
        isSafeMode: () => cfg().enabled && safeMode !== null,
        status: () => (cfg().enabled && safeMode ? { since: safeMode.since, reason: safeMode.reason, statements: safeMode.statements, bytes: safeMode.bytes } : null),
        attachLogger: (next) => { if (next) log = next },
        snapshot: () => ({ enabled: cfg().enabled, totals: { ...totals }, activeRules: rulesSeen.size, limits: limits(), safeMode: safeMode ? { ...safeMode } : null, alerts }),
    }
}

// Rolling per-owner budget for user-initiated writes, in 5-minute buckets. Owners are kept in LRU order and
// idle owners fall off after an hour, so the map stays bounded by maxOwners.
export function createOwnerBudget({ env = process.env, now = () => Date.now(), maxOwners = OWNER_BUDGET_DEFAULTS.maxOwners } = {}) {
    let config = null
    const cfg = () => (config ??= {
        enabled: tripwireEnabled(env),
        statements: positiveInt(env.AUTOPILOT_OWNER_WRITES_PER_HOUR) || OWNER_BUDGET_DEFAULTS.statementsPerHour,
        bytes: positiveInt(env.AUTOPILOT_OWNER_ADDON_LIST_BYTES_PER_HOUR) || OWNER_BUDGET_DEFAULTS.addonListBytesPerHour,
    })
    const owners = new Map()
    let lastPrune = 0

    const evict = (entry, t) => {
        while (entry.buckets.length > 0 && t - entry.buckets[0].start >= HOUR_MS) {
            const old = entry.buckets.shift()
            entry.statements -= old.statements
            entry.bytes -= old.bytes
        }
    }

    const prune = (t) => {
        if (t - lastPrune < OWNER_BUCKET_MS) return
        lastPrune = t
        for (const [owner, entry] of owners) {
            if (t - entry.touched < HOUR_MS) break
            owners.delete(owner)
        }
    }

    const charge = (owner, kind, params) => {
        if (!cfg().enabled || !kind?.watched) return
        const t = now()
        prune(t)
        const key = String(owner ?? '')
        let entry = owners.get(key)
        if (entry) owners.delete(key)
        else entry = { buckets: [], statements: 0, bytes: 0, touched: t }
        entry.touched = t
        owners.set(key, entry)
        while (owners.size > maxOwners) owners.delete(owners.keys().next().value)
        evict(entry, t)
        const start = t - (t % OWNER_BUCKET_MS)
        let bucket = entry.buckets[entry.buckets.length - 1]
        if (!bucket || bucket.start !== start) {
            bucket = { start, statements: 0, bytes: 0 }
            entry.buckets.push(bucket)
        }
        const bytes = kind.addonList ? paramBytes(params) : 0
        bucket.statements++
        entry.statements++
        bucket.bytes += bytes
        entry.bytes += bytes
    }

    // 0 when the owner may write; otherwise ms until enough of the window rolls off.
    const retryAfterMs = (owner) => {
        if (!cfg().enabled) return 0
        const t = now()
        prune(t)
        const entry = owners.get(String(owner ?? ''))
        if (!entry) return 0
        evict(entry, t)
        const { statements: maxStatements, bytes: maxBytes } = cfg()
        let statements = entry.statements
        let bytes = entry.bytes
        if (statements < maxStatements && bytes < maxBytes) return 0
        for (const bucket of entry.buckets) {
            statements -= bucket.statements
            bytes -= bucket.bytes
            if (statements < maxStatements && bytes < maxBytes) return Math.max(1, bucket.start + HOUR_MS - t)
        }
        return HOUR_MS
    }

    return {
        charge,
        retryAfterMs,
        snapshot: (owner) => {
            const entry = owners.get(String(owner ?? ''))
            return { owners: owners.size, statements: entry?.statements ?? 0, bytes: entry?.bytes ?? 0, limits: { statements: cfg().statements, bytes: cfg().bytes } }
        },
    }
}

let current = createWriteTripwire()
let ownerBudget = createOwnerBudget()

// Process-wide facade; tests swap the instance with resetAutopilotTripwire.
export const autopilotTripwire = {
    checkStatement: (sql, params) => current.checkStatement(sql, params),
    assertWritable: () => current.assertWritable(),
    noteRule: (id) => current.noteRule(id),
    remind: () => current.remind(),
    isSafeMode: () => current.isSafeMode(),
    status: () => current.status(),
    attachLogger: (log) => current.attachLogger(log),
    snapshot: () => current.snapshot(),
}

export const resetAutopilotTripwire = (opts) => {
    current = createWriteTripwire(opts)
    return autopilotTripwire
}

export const autopilotOwnerBudget = {
    retryAfterMs: (owner) => ownerBudget.retryAfterMs(owner),
    snapshot: (owner) => ownerBudget.snapshot(owner),
}

export const resetAutopilotOwnerBudget = (opts) => {
    ownerBudget = createOwnerBudget(opts)
    return autopilotOwnerBudget
}

const ownerScope = new AsyncLocalStorage()

// Engine work started on behalf of a user (the save echo) runs here: its writes are charged to that owner's
// budget instead of the instance tripwire, and still stop in safe mode.
export const runAsOwner = (owner, fn) => ownerScope.run({ owner }, fn)

const chargeOwner = (owner, sql, params, honorSafeMode) => {
    const kind = classifyStatement(sql)
    if (!kind) return null
    if (honorSafeMode && autopilotTripwire.isSafeMode()) {
        autopilotTripwire.remind()
        return new AutopilotSafeModeError()
    }
    ownerBudget.charge(owner, kind, params)
    return null
}

const gated = (sql, params, run) => {
    const scope = ownerScope.getStore()
    const blocked = scope ? chargeOwner(scope.owner, sql, params, true) : autopilotTripwire.checkStatement(sql, params)
    return blocked ? Promise.reject(blocked) : run()
}

const guardedClients = new WeakMap()
const proxyClient = (client, gate) => new Proxy(client, {
    get(target, prop) {
        const value = Reflect.get(target, prop)
        if (prop === 'query' && typeof value === 'function') return (...args) => gate(args[0], args[1], () => value.apply(target, args))
        if (prop === 'connect' && typeof value === 'function') return async (...args) => guardClient(await value.apply(target, args), gate)
        return typeof value === 'function' ? value.bind(target) : value
    },
})

// Only the shared engine gate is cached; per-owner gates are short-lived.
const guardClient = (client, gate = gated) => {
    if (!client || typeof client !== 'object') return client
    if (gate !== gated) return proxyClient(client, gate)
    if (!guardedClients.has(client)) guardedClients.set(client, proxyClient(client, gate))
    return guardedClients.get(client)
}

const guardConn = (conn, gate) => ({
    query: (...args) => gate(args[0], args[1], () => conn.query(...args)),
    get: (...args) => gate(args[0], args[1], () => conn.get(...args)),
    run: (...args) => gate(args[0], args[1], () => conn.run(...args)),
})

// The only db handle the engine sees. Calls resolve on the target at call time so test instrumentation still
// applies; the raw SQLite client and statement cache are not reachable through it.
export function guardDb(target, gate = gated) {
    return Object.freeze({
        get type() { return target.type },
        get isHealthy() { return target.isHealthy },
        get pool() { return guardClient(target.pool, gate) },
        query: (...args) => gate(args[0], args[1], () => target.query(...args)),
        get: (...args) => gate(args[0], args[1], () => target.get(...args)),
        run: (...args) => gate(args[0], args[1], () => target.run(...args)),
        exec: (...args) => gate(args[0], undefined, () => target.exec(...args)),
        tx: (fn) => target.tx((conn) => fn(guardConn(conn, gate))),
    })
}

// Handle for a user's own rule saves: charged to the owner's budget, never to the instance tripwire, and not
// stopped by safe mode (saving a rule is not an Autopilot side effect).
export const ownerSaveDb = (owner, target = rawDb) => guardDb(target, (sql, params, run) => {
    chargeOwner(owner, sql, params, false)
    return run()
})

// Provider and fetch wrappers: in safe mode every method outside the read allowlist throws before it runs.
// Methods are bound to the proxy so a read that calls this.write* is still gated.
export function guardProvider(target, reads = []) {
    if (!target) return target
    const allowed = new Set(reads)
    return new Proxy(target, {
        get(obj, prop, receiver) {
            const value = Reflect.get(obj, prop)
            if (typeof value !== 'function') return value
            if (allowed.has(prop)) return value.bind(receiver)
            return (...args) => {
                autopilotTripwire.assertWritable()
                return value.apply(receiver, args)
            }
        },
    })
}

export function guardFetch(fetchImpl) {
    return (url, init = {}) => {
        const method = String(init?.method || 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'HEAD') {
            try { autopilotTripwire.assertWritable() } catch (err) { return Promise.reject(err) }
        }
        return fetchImpl(url, init)
    }
}

export const autopilotDb = guardDb(rawDb)
