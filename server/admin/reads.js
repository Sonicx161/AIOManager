import fs from 'fs'
import os from 'os'
import { monitorEventLoopDelay } from 'perf_hooks'
import db from '../db.js'
import { VERSION, BUILD_ID, DATA_DIR, isReadOnlyReplica, PROXY_CONCURRENCY_LIMIT, MAX_QUEUE_SIZE } from '../config.js'
import { env } from '../lib/env.js'
import { serverState, proxyQueue, proxyQueueKeyCounts, globalHealthCache, authCache } from '../state.js'
import { autopilotTripwire } from '../autopilot/write-tripwire.js'
import { metadataCache } from '../lib/metadata-cache.js'
import { syncResponseCacheStats } from '../lib/sync-response-cache.js'
import { readCacheLayers, readTasks, registerTask } from '../lib/ops-metrics.js'
import { cachedRead, adminRead } from './cached-read.js'
import { listAudit } from './audit.js'
import { platformKey, accountHandle } from '../utils/acct-handle.js'

const DAY = 24 * 60 * 60 * 1000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const GUARANTEES = [
    'The Dashboard manages this instance, never the people on it.',
    'It cannot read addon lists, watch history, vault entries, credentials, rules or synced data.',
    'It cannot sign in as a user, export user data or show unredacted logs.',
    'Secrets are shown only as Set or Not set.',
    'Deleting an account is soft, needs a written reason and typed confirmation, and the user is notified.',
    'Every Dashboard action is written to a hash-chained audit log that the Dashboard cannot edit or clear.',
]

export const REPAIR_CATALOG = [
    { key: 'clear-login-backoff', tier: 1, label: 'Clear login backoff' },
    // Honest relabel: no server-side sync lease exists; this clears the sync response
    // cache and cached sign-in entries for the account.
    { key: 'release-sync-lease', tier: 1, label: "Clear this account's sync server caches", description: "There is no server-side sync lease to release. This clears the server's cached sync responses and cached sign-in entries for the account, so the next sign-in and sync pull do their full verification work again." },
    { key: 'clear-server-caches', tier: 1, label: "Clear this account's server caches" },
    { key: 'reset-activity-breaker', tier: 1, label: 'Reset the activity scan breaker' },
    { key: 'recheck-failover', tier: 1, label: 'Re-run the Failover health check' },
    { key: 'refresh-connection-token', tier: 1, label: 'Force a connection token refresh' },
    { key: 'purge-orphaned-state', tier: 1, label: 'Purge orphaned server state' },
]

// The tier-1 keys with a shipped implementation this wave. The owner-cut keys
// (refresh-connection-token, purge-orphaned-state, recheck-failover) stay listed
// but unavailable.
export const AVAILABLE_REPAIRS = new Set(['clear-login-backoff', 'release-sync-lease', 'clear-server-caches', 'reset-activity-breaker'])

export function repairCatalogForStatus(status) {
    return REPAIR_CATALOG.map((r) => ({ ...r, available: r.tier === 1 && AVAILABLE_REPAIRS.has(r.key) && status !== 'deleted' }))
}

const mb = (n) => Math.round((n / 1048576) * 10) / 10

// platformKey and accountHandle are re-exported from the shared module so the Dashboard log
// ring renders exactly the same labels as the Users screen.
export { platformKey, accountHandle }
const labelKey = (v) => {
    const s = String(v ?? '').toLowerCase()
    return /^[a-z][a-z_-]{0,31}$/.test(s) && !(s in Object.prototype) && s !== '__proto__' ? s : 'other'
}
const counter = () => Object.create(null)
const bump = (obj, key, n) => { obj[key] = (obj[key] || 0) + n }
const dayOf = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : null)
const monthOf = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 7) : null)
const num = (v) => Number(v) || 0

export function createSystemSampler({ intervalMs = 60_000, points = 60 } = {}) {
    const histogram = monitorEventLoopDelay({ resolution: 20 })
    histogram.enable()
    const ring = []
    let lastSampleAt = null
    const ms = (ns) => Math.round(ns / 1e5) / 10
    const sample = () => {
        const mem = process.memoryUsage()
        lastSampleAt = Date.now()
        ring.push({ t: lastSampleAt, rssMb: mb(mem.rss), heapUsedMb: mb(mem.heapUsed), loopP99Ms: ms(histogram.percentile(99)), proxyQueue: proxyQueue.length })
        if (ring.length > points) ring.shift()
        histogram.reset()
    }
    const timer = setInterval(sample, intervalMs)
    timer.unref?.()
    registerTask('dashboard-sampler', { label: 'Dashboard system sampler (memory only)', intervalMs, lastRunAt: () => lastSampleAt })
    return {
        loop: () => ({ p50Ms: ms(histogram.percentile(50)), p99Ms: ms(histogram.percentile(99)), maxMs: ms(histogram.max) }),
        ring: () => ring.slice(),
        sample,
        stop: () => { clearInterval(timer); histogram.disable() },
    }
}

async function databaseInfo() {
    const healthy = await db.healthCheck()
    const info = { type: db.type, healthy, sizeBytes: null, freeBytes: null, walBytes: null }
    if (!healthy) return info
    try {
        if (db.type === 'sqlite') {
            const pageSize = num((await db.pragma('page_size'))?.[0]?.page_size)
            const pages = num((await db.pragma('page_count'))?.[0]?.page_count)
            const free = num((await db.pragma('freelist_count'))?.[0]?.freelist_count)
            info.sizeBytes = pageSize * pages
            info.freeBytes = pageSize * free
            const path = process.env.SQLITE_DB_PATH
            if (path && path !== ':memory:' && fs.existsSync(`${path}-wal`)) info.walBytes = fs.statSync(`${path}-wal`).size
        } else {
            const row = await adminRead((q) => q.get('SELECT pg_database_size(current_database()) AS bytes', []))
            info.sizeBytes = num(row?.bytes)
        }
    } catch { /* size is best-effort */ }
    return info
}

// DP-13: host and build facts for the System environment cards. Everything is
// computed locally: static facts once per process, the db version through one
// cheap read-only query, memoized. No hostname, username, address or env value
// ever enters the payload, and nothing here writes, so it is safe on a
// read-only replica.
let environmentStatic = null
let dbVersionMemo = null

function readOsName() {
    try {
        const text = fs.readFileSync('/etc/os-release', 'utf8')
        const pretty = /^PRETTY_NAME="?([^"\n]+?)"?\s*$/m.exec(text)
        if (pretty?.[1]) return pretty[1].trim()
    } catch { /* not readable: Windows, macOS or a stripped container */ }
    return `${os.type()} ${os.release()}`.trim()
}

function readTimezone() {
    try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
        if (!zone) return null
        const offsetMin = -new Date().getTimezoneOffset()
        const sign = offsetMin < 0 ? '-' : '+'
        const abs = Math.abs(offsetMin)
        const hh = String(Math.floor(abs / 60)).padStart(2, '0')
        const mm = String(abs % 60).padStart(2, '0')
        return `${zone} (UTC${sign}${hh}:${mm})`
    } catch { return null }
}

function detectContainerRuntime() {
    try { fs.statSync('/.dockerenv'); return 'docker' } catch { /* not docker */ }
    try {
        const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8')
        for (const needle of ['docker', 'containerd', 'kubepods', 'lxc']) {
            if (cgroup.includes(needle)) return needle
        }
    } catch { /* no cgroup file */ }
    return null
}

// The data folder path is fine to show, but a home directory or username
// segment collapses to ~ so the payload never names a person or machine.
function redactDataDir(dir) {
    const raw = String(dir || '').trim()
    if (!raw) return null
    let out = raw
    const norm = (s) => s.replace(/\\/g, '/')
    const home = norm(os.homedir() || '')
    if (home && norm(out).toLowerCase().startsWith(`${home.toLowerCase()}/`)) {
        // norm() only swaps separators, so character counts stay aligned.
        out = `~${out.slice(home.length)}`
    } else {
        let user = null
        try { user = os.userInfo().username } catch { /* unavailable on this platform */ }
        if (user) {
            const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            out = out.replace(new RegExp(`(^|[\\\\/])${escaped}([\\\\/]|$)`, 'i'), '$1~$2')
        }
    }
    return out || null
}

async function computeDbVersion() {
    try {
        if (db.type === 'postgres') {
            const row = await adminRead((q) => q.get("SELECT current_setting('server_version') AS v", []))
            return row?.v ? String(row.v) : null
        }
        const row = await adminRead((q) => q.get('SELECT sqlite_version() AS v', []))
        return row?.v ? String(row.v) : null
    } catch { return null }
}

export function readEnvironment() {
    if (!environmentStatic) {
        const cpus = os.cpus()
        const containerRuntime = detectContainerRuntime()
        environmentStatic = {
            os: readOsName(),
            cpuModel: cpus.length ? String(cpus[0].model || '').trim() || null : null,
            cpuCores: cpus.length || null,
            totalMemBytes: Number.isFinite(os.totalmem()) && os.totalmem() > 0 ? os.totalmem() : null,
            timezone: readTimezone(),
            node: process.version,
            arch: process.arch,
            container: { detected: containerRuntime !== null, runtime: containerRuntime, runtimeVersion: null },
            db: { engine: db.type === 'postgres' ? 'postgres' : 'sqlite', version: null },
            dataDir: redactDataDir(DATA_DIR),
            build: BUILD_ID ? { commit: BUILD_ID, date: null } : null,
        }
    }
    if (!dbVersionMemo) dbVersionMemo = computeDbVersion()
    return dbVersionMemo.then((version) => ({ ...environmentStatic, db: { ...environmentStatic.db, version } }))
}
readEnvironment.reset = () => { environmentStatic = null; dbVersionMemo = null }

function summarizeUser(id, parts, now) {
    const { kv, hist, creds, rules, devices, subs, adminState } = parts
    const seen = [kv?.updated_at, devices?.last_used, subs?.last_seen].map(num).filter(Boolean)
    const firstSeen = [kv?.updated_at, hist?.first_at, devices?.first_at].map(num).filter(Boolean)
    const lastSeenAt = seen.length ? Math.max(...seen) : null
    const firstSeenAt = firstSeen.length ? Math.min(...firstSeen) : null
    const connections = counter()
    for (const [k, v] of Object.entries(creds || {})) bump(connections, k, v)
    if (subs?.n) bump(connections, 'hydra', num(subs.n))
    // firstSeenMs/lastSeenMs stay internal for sort and cursor; listUsers strips them.
    const status = adminState?.deleted_at ? 'deleted' : adminState?.disabled_at ? 'disabled' : 'active'
    return {
        handle: accountHandle(id),
        firstSeenMs: firstSeenAt,
        lastSeenMs: lastSeenAt,
        firstSeenMonth: monthOf(firstSeenAt),
        lastSeenDay: dayOf(lastSeenAt),
        // Whole hours only inside 48 h, so "Active today" never sits next to "yesterday".
        lastSeenHoursAgo: lastSeenAt && now - lastSeenAt < 2 * DAY ? Math.floor((now - lastSeenAt) / 3_600_000) : null,
        inactiveDays: lastSeenAt ? Math.floor((now - lastSeenAt) / DAY) : null,
        status,
        restoreUntil: status === 'deleted' && adminState?.restore_until ? new Date(Number(adminState.restore_until)).toISOString() : null,
        connections,
        rules: { total: num(rules?.total), active: num(rules?.active) },
        storageBytes: num(kv?.bytes) + num(hist?.bytes),
    }
}

// Aggregates only: ids, timestamps, sizes and counts. Size uses octet_length / pg_column_size,
// which read the stored length, never the blob content.
async function loadUsers(now = Date.now()) {
    const size = db.type === 'postgres' ? 'pg_column_size(value)' : 'octet_length(value)'
    const rows = await adminRead(async (q) => ({
        kv: await q.query(`SELECT key, updated_at, ${size} AS bytes FROM kv_store`, []),
        hist: await q.query(`SELECT key, MIN(archived_at) AS first_at, SUM(${size}) AS bytes FROM kv_store_history GROUP BY key`, []),
        creds: await q.query('SELECT sync_user, credential_type, COUNT(*) AS n FROM server_credentials GROUP BY sync_user, credential_type', []),
        rules: await q.query('SELECT owner_sync_user, is_active, COUNT(*) AS n FROM autopilot_rules GROUP BY owner_sync_user, is_active', []),
        devices: await q.query('SELECT account_uuid, MAX(last_used_at) AS last_used, MIN(created_at) AS first_at FROM device_credentials WHERE revoked = 0 GROUP BY account_uuid', []),
        subs: await q.query('SELECT sync_user, COUNT(*) AS n, MAX(last_seen_at) AS last_seen FROM hydra_subscribers GROUP BY sync_user', []),
        adminStates: await q.query('SELECT sync_user, disabled_at, deleted_at, restore_until FROM account_admin_state', []),
    }))
    const by = (list, key) => new Map(list.map((r) => [r[key], r]))
    const hist = new Map()
    for (const r of rows.hist) hist.set(r.key, { first_at: r.first_at, bytes: r.bytes })
    const creds = new Map()
    for (const r of rows.creds) {
        const m = creds.get(r.sync_user) || counter()
        bump(m, platformKey(r.credential_type), num(r.n))
        creds.set(r.sync_user, m)
    }
    const rules = new Map()
    for (const r of rows.rules) {
        const m = rules.get(r.owner_sync_user) || { total: 0, active: 0 }
        m.total += num(r.n)
        if (Number(r.is_active) === 1 || r.is_active === true) m.active += num(r.n)
        rules.set(r.owner_sync_user, m)
    }
    const devices = by(rows.devices, 'account_uuid')
    const subs = by(rows.subs, 'sync_user')
    const adminStates = by(rows.adminStates, 'sync_user')
    const users = []
    for (const kv of rows.kv) {
        if (!UUID_RE.test(String(kv.key))) continue
        users.push(summarizeUser(kv.key, { kv, hist: hist.get(kv.key), creds: creds.get(kv.key), rules: rules.get(kv.key), devices: devices.get(kv.key), subs: subs.get(kv.key), adminState: adminStates.get(kv.key) }, now))
    }
    users.sort((a, b) => (a.inactiveDays ?? 1e9) - (b.inactiveDays ?? 1e9) || a.handle.localeCompare(b.handle))
    return { users, computedAt: now }
}

export const BULK_DELETE_CAP = 25
const isInactive180 = (u) => u.inactiveDays === null || u.inactiveDays >= 180
const USER_FILTERS = {
    // The default view hides deleted accounts; the explicit deleted filter shows them.
    all: (u) => u.status !== 'deleted',
    active: (u) => u.inactiveDays !== null && u.inactiveDays < 30 && u.status !== 'deleted',
    'active-today': (u) => u.inactiveDays === 0 && u.status !== 'deleted',
    'active-7d': (u) => u.inactiveDays !== null && u.inactiveDays < 7 && u.status !== 'deleted',
    inactive: isInactive180,
    'inactive-180': isInactive180,
    'with-rules': (u) => u.rules.total > 0,
    'with-failover': (u) => u.rules.active > 0,
    disabled: (u) => u.status === 'disabled',
    deleted: (u) => u.status === 'deleted',
}

// Handle-prefix search: strict shape after lowercasing, matched against computed
// handles only (never keys, emails or any content, which the aggregate never holds).
const QUERY_RE = /^acct-[0-9a-f]{0,12}$/
const SORTS = {
    created: (u) => u.firstSeenMs ?? 0,
    lastseen: (u) => u.lastSeenMs ?? 0,
}

function cycleEndedAt(cycle) {
    const { startedAt: start, durationMs: duration } = cycle
    if (typeof start !== 'number' || typeof duration !== 'number') return null
    const end = start + duration
    return Number.isFinite(end) ? end : null
}

export function createReads({ autopilotEngine = null, activityEngine = null, limiter = null, sessions = null, sampler = null, hostSampler = null } = {}) {
    registerTask('autopilot-worker', {
        label: 'Autopilot health cycle',
        intervalMs: 60_000,
        enabled: () => !isReadOnlyReplica(),
        running: () => serverState.isWorkerRunning,
        lastRunAt: () => serverState.autopilotLastCycleEndedAt || null,
    })
    if (activityEngine) {
        registerTask('activity-scan', {
            label: 'Activity scan (Stremio only)',
            intervalMs: () => activityEngine.getConfig?.().intervalMs ?? null,
            enabled: () => activityEngine.isEnabled?.() && !isReadOnlyReplica(),
            running: () => activityEngine.isRunning?.(),
            lastRunAt: () => activityEngine.getStatus?.().lastCycle?.startedAt ?? null,
        })
    }
    registerTask('metadata-cache-cleanup', {
        label: 'Metadata cache cleanup',
        intervalMs: 60 * 60 * 1000,
        enabled: () => Boolean(metadataCache.cleanupTimer),
        lastRunAt: () => metadataCache.stats?.last_cleanup_at || null,
    })

    const users = cachedRead(60_000, () => loadUsers(), { failTtlMs: 30_000 })

    const system = cachedRead(30_000, async () => {
        const mem = process.memoryUsage()
        return {
            version: VERSION,
            mode: isReadOnlyReplica() ? 'read-only-replica' : 'multi-tenant',
            readOnly: isReadOnlyReplica(),
            node: process.version,
            platform: process.platform,
            uptimeSec: Math.round(process.uptime()),
            startedAt: Date.now() - Math.round(process.uptime() * 1000),
            memory: { rssMb: mb(mem.rss), heapUsedMb: mb(mem.heapUsed), heapTotalMb: mb(mem.heapTotal), externalMb: mb(mem.external) },
            eventLoop: sampler ? sampler.loop() : null,
            database: await databaseInfo(),
            history: sampler ? sampler.ring() : [],
            environment: await readEnvironment(),
            computedAt: Date.now(),
        }
    })

    const autopilot = cachedRead(30_000, async () => {
        const now = Date.now()
        const counts = await adminRead(async (q) => ({
            rules: await q.query('SELECT platform, is_active, is_automatic, COUNT(*) AS n FROM autopilot_rules GROUP BY platform, is_active, is_automatic', []),
            failovers: await q.query('SELECT type, COUNT(*) AS n FROM failover_history WHERE timestamp > $1 GROUP BY type', [now - DAY]),
        }))
        const byPlatform = counter()
        let active = 0
        let automatic = 0
        let total = 0
        for (const r of counts.rules) {
            const p = platformKey(r.platform)
            const n = num(r.n)
            byPlatform[p] ||= { total: 0, active: 0 }
            byPlatform[p].total += n
            total += n
            if (Number(r.is_active) === 1 || r.is_active === true) { byPlatform[p].active += n; active += n }
            if (Number(r.is_automatic) === 1 || r.is_automatic === true) automatic += n
        }
        const failovers24h = counter()
        for (const r of counts.failovers) bump(failovers24h, labelKey(r.type), num(r.n))
        const trip = autopilotTripwire.snapshot()
        return {
            worker: {
                running: serverState.isWorkerRunning,
                intervalMs: 60_000,
                lastRunAt: serverState.lastWorkerRun || null,
                lastCycleEndedAt: serverState.autopilotLastCycleEndedAt || null,
                lastCycle: serverState.autopilotLastCycleStats ? { scanned: serverState.autopilotLastCycleStats.scanned, budgetHit: serverState.autopilotLastCycleStats.budgetHit, durationMs: serverState.autopilotLastCycleStats.durationMs } : null,
                recheckMs: env.AUTOPILOT_RULE_RECHECK_MS,
                cycleBudgetMs: env.AUTOPILOT_CYCLE_BUDGET_MS,
                disabledReason: isReadOnlyReplica() ? 'read-only replica' : null,
            },
            rules: { total, active, automatic, byPlatform },
            failovers24h,
            tripwire: {
                enabled: trip.enabled,
                statementsLastHour: trip.totals?.statements ?? 0,
                bytesLastHour: trip.totals?.bytes ?? 0,
                limits: trip.limits,
                activeRules: trip.activeRules,
                safeMode: trip.safeMode ? { since: trip.safeMode.since, reason: trip.safeMode.reason } : null,
            },
            caches: {
                rules: autopilotEngine?.getRuleCacheStats ? autopilotEngine.getRuleCacheStats() : null,
                ruleDecrypt: autopilotEngine?.getRuleDecryptCacheStats ? autopilotEngine.getRuleDecryptCacheStats() : null,
            },
            computedAt: now,
        }
    })

    const activity = cachedRead(30_000, async () => {
        const status = activityEngine?.getStatus ? activityEngine.getStatus() : null
        return {
            enabled: Boolean(status?.enabled),
            running: Boolean(status?.running),
            lastCycle: status?.lastCycle ?? null,
            breakerEntries: status?.breakerEntries ?? 0,
            config: activityEngine?.getConfig ? activityEngine.getConfig() : null,
            scope: 'Server-side activity capture scans Stremio connections only. Nuvio, RealStream and Hydra activity is tracked by the app on the device.',
            computedAt: Date.now(),
        }
    })

    const tasks = cachedRead(30_000, async () => ({ items: readTasks(), runNowAvailable: false, computedAt: Date.now() }))

    const cache = cachedRead(30_000, async () => {
        let busiestKeyCount = 0
        for (const c of proxyQueueKeyCounts.values()) busiestKeyCount = Math.max(busiestKeyCount, c)
        let metadata = null
        try { metadata = await metadataCache.getStats() } catch { metadata = null }
        return {
            layers: [
                { id: 'metadata', label: 'Metadata cache (memory + database)', ...(metadata || { error: 'unavailable' }) },
                { id: 'sync-response', label: 'Sync response cache', ...syncResponseCacheStats() },
                { id: 'rules', label: 'Autopilot rule cache', ...(autopilotEngine?.getRuleCacheStats?.() || {}) },
                { id: 'rule-decrypt', label: 'Autopilot rule decrypt cache', ...(autopilotEngine?.getRuleDecryptCacheStats?.() || {}) },
                { id: 'health', label: 'Addon health cache', entries: globalHealthCache.size },
                { id: 'auth', label: 'Sign-in verification cache', entries: authCache.size },
                ...readCacheLayers(),
            ],
            proxyQueue: { length: proxyQueue.length, max: MAX_QUEUE_SIZE, active: serverState.activeProxyRequests, concurrency: PROXY_CONCURRENCY_LIMIT, distinctKeys: proxyQueueKeyCounts.size, busiestKeyCount },
            clearAvailable: false,
            computedAt: Date.now(),
        }
    })

    // Numbers only: host/process samples plus worker freshness already held in memory.
    // The first sample decides db and disk availability: wait for it (3 s cap) and never
    // keep a pre-ready snapshot in the cache.
    let samplerReady = !hostSampler?.ready
    hostSampler?.ready?.then(() => { samplerReady = true })
    const metricsCached = cachedRead(30_000, async () => {
        if (!samplerReady) await Promise.race([hostSampler.ready, new Promise(resolve => setTimeout(resolve, 3_000).unref?.())])
        const status = activityEngine?.getStatus ? activityEngine.getStatus() : null
        return {
            sampledEveryMs: hostSampler?.intervalMs ?? 60_000,
            now: hostSampler ? hostSampler.live() : null,
            series: hostSampler ? hostSampler.series() : [],
            db: hostSampler ? hostSampler.dbSnapshot() : null,
            disk: hostSampler ? hostSampler.diskSnapshot() : null,
            workers: {
                // Freshness shape the client design reads: enabled, running, lastCycle { endedAt, error }.
                autopilot: {
                    enabled: !isReadOnlyReplica(),
                    running: serverState.isWorkerRunning,
                    lastCycle: serverState.autopilotLastCycleEndedAt
                        ? { endedAt: serverState.autopilotLastCycleEndedAt, error: null }
                        : null,
                },
                activity: status ? {
                    enabled: Boolean(status.enabled),
                    running: Boolean(status.running),
                    lastCycle: status.lastCycle && (status.lastCycle.startedAt != null || status.lastCycle.error)
                        ? { endedAt: cycleEndedAt(status.lastCycle), error: status.lastCycle.error ?? null }
                        : null,
                } : null,
            },
            limits: {
                points: hostSampler?.points ?? 60,
                sampledEveryMs: hostSampler?.intervalMs ?? 60_000,
                window: 'One point per sample; the ring keeps the last 60 points (about one hour).',
            },
            notes: {
                sampling: 'Sampled in memory by a background timer. Reading this endpoint writes nothing to the database.',
                cpu: 'Busy share of CPU time between two samples; null until the second sample.',
                loadavg: 'Reported only where the platform provides non-zero values.',
                db: 'SQLite sizes are the main file plus WAL and SHM; PostgreSQL reports the database size.',
                disk: 'Free and total bytes of the filesystem holding the data directory.',
            },
            computedAt: Date.now(),
        }
    })

    const recentAudit = cachedRead(30_000, async () => (await listAudit({ limit: 5 })).rows
        .map((r) => ({ seq: r.seq, at: r.at, event: r.event, action: r.action, detail: r.detail, hashPrefix: r.hash.slice(0, 8) })))

    const overview = cachedRead(30_000, async () => {
        // Each block degrades on its own: a failed read nulls its KPIs and raises a signal.
        const settled = await Promise.allSettled([system(), autopilot(), users(), activity(), recentAudit()])
        const [sys, ap, us, act, audit] = settled.map((r) => (r.status === 'fulfilled' ? r.value : null))
        const now = Date.now()
        const signals = []
        const add = (severity, key, text) => signals.push({ severity, key, text })
        if (!sys) add('watch', 'system-unavailable', 'System figures are temporarily unavailable.')
        if (!ap) add('watch', 'autopilot-unavailable', 'Autopilot figures are temporarily unavailable.')
        if (!us) add('watch', 'users-unavailable', 'Account figures are temporarily unavailable (the account read failed or timed out).')
        if (sys && !sys.database.healthy) add('action', 'db-unhealthy', 'The database is not answering health checks.')
        if (ap?.tripwire.safeMode) add('action', 'autopilot-safe-mode', 'Autopilot is in safe mode after its write tripwire tripped. Fix the cause, then restart.')
        if (!isReadOnlyReplica() && serverState.lastWorkerRun && now - serverState.lastWorkerRun > 5 * 60_000) add('action', 'autopilot-stalled', 'Autopilot has not started a cycle in over 5 minutes.')
        const statementShare = ap?.tripwire.limits?.statements ? ap.tripwire.statementsLastHour / ap.tripwire.limits.statements : 0
        if (statementShare >= 0.75 && !ap.tripwire.safeMode) add('watch', 'tripwire-near', `Autopilot used ${Math.round(statementShare * 100)}% of its hourly write budget.`)
        if (sys?.eventLoop && sys.eventLoop.p99Ms >= 200) add('watch', 'event-loop', `Event loop delay p99 is ${sys.eventLoop.p99Ms} ms.`)
        if (proxyQueue.length >= MAX_QUEUE_SIZE * 0.8) add('watch', 'proxy-queue', `The outbound proxy queue is ${proxyQueue.length}/${MAX_QUEUE_SIZE}.`)
        const lock = limiter?.snapshot ? limiter.snapshot() : null
        if (lock?.globalLockedUntil) add('watch', 'dashboard-global-lock', 'Dashboard sign-in is globally locked after repeated failures.')
        else if (lock?.lockedIps) add('info', 'dashboard-ip-lock', `${lock.lockedIps} address(es) are locked out of Dashboard sign-in.`)
        if (lock?.lockedPrefixes) add('watch', 'dashboard-prefix-lock', `${lock.lockedPrefixes} network prefix(es) are locked out of Dashboard sign-in after repeated failures.`)
        if (act?.enabled && act.lastCycle?.error) add('watch', 'activity-failed', 'The last activity scan failed.')
        if (act?.breakerEntries) add('info', 'activity-breaker', `${act.breakerEntries} connection(s) are backing off in the activity scanner.`)
        const rank = { action: 0, watch: 1, info: 2 }
        signals.sort((a, b) => rank[a.severity] - rank[b.severity])
        const verdict = signals.some((s) => s.severity === 'action') ? 'action' : signals.some((s) => s.severity === 'watch') ? 'watch' : 'ok'
        let connections = null
        if (us) {
            connections = counter()
            for (const u of us.users) for (const [k, v] of Object.entries(u.connections)) bump(connections, k, v)
        }
        return {
            verdict,
            kpis: {
                accounts: us ? us.users.length : null,
                active7d: us ? us.users.filter((u) => u.inactiveDays !== null && u.inactiveDays < 7).length : null,
                active30d: us ? us.users.filter(USER_FILTERS.active).length : null,
                rulesActive: ap ? ap.rules.active : null,
                connections,
                failovers24h: ap ? Object.values(ap.failovers24h).reduce((a, b) => a + b, 0) : null,
                uptimeSec: Math.round(process.uptime()),
                dbSizeBytes: sys ? sys.database.sizeBytes : null,
                version: VERSION,
                adminSessions: sessions ? (await sessions.list().catch(() => null))?.length ?? null : null,
            },
            signals,
            recentAudit: audit || [],
            guarantees: GUARANTEES,
            computedAt: now,
        }
    })

    async function listUsers({ filter = 'all', cursor = null, limit = 50, q = null, sort = 'lastseen', order = 'desc' } = {}) {
        const { users: all, computedAt } = await users()
        let query = null
        if (q != null && q !== '') {
            query = String(q).toLowerCase()
            if (!QUERY_RE.test(query)) {
                const err = new Error('q must be an acct- handle prefix (lowercase hex).')
                err.code = 'query_invalid'
                throw err
            }
        }
        const fn = USER_FILTERS[filter] || USER_FILTERS.all
        let matched = all.filter(query ? (u) => u.handle.startsWith(query) : fn)
        if (query) matched = matched.filter(fn)
        const sortFn = SORTS[sort] || SORTS.lastseen
        const direction = order === 'asc' ? 1 : -1
        matched = [...matched].sort((a, b) => direction * (sortFn(a) - sortFn(b)) || a.handle.localeCompare(b.handle))
        const start = cursor && /^\d+$/.test(String(cursor)) ? Number(cursor) : 0
        const size = Math.max(1, Math.min(100, Number(limit) || 50))
        // Internal epoch fields never leave the server; the display fields stay coarse.
        const rows = matched.slice(start, start + size).map(({ firstSeenMs, lastSeenMs, ...row }) => row)
        return {
            rows,
            cursor: start + size < matched.length ? String(start + size) : null,
            total: matched.length,
            filters: {
                accounts: all.length,
                syncedToday: all.filter(USER_FILTERS['active-today']).length,
                active7d: all.filter(USER_FILTERS['active-7d']).length,
                inactive180: all.filter(isInactive180).length,
            },
            bulkCap: BULK_DELETE_CAP,
            computedAt,
        }
    }

    async function getUser(handle) {
        if (!/^acct-[0-9a-f]{12}$/.test(String(handle))) return null
        const { users: all, computedAt } = await users()
        const user = all.find((u) => u.handle === handle)
        if (!user) return null
        const { firstSeenMs: _firstSeenMs, lastSeenMs: _lastSeenMs, ...row } = user
        return {
            ...row,
            repairs: repairCatalogForStatus(row.status),
            // Deleted accounts keep only the Restore action; the cut of the action set
            // mirrors what the mutation routes accept.
            actionsAvailable: row.status !== 'deleted',
            computedAt,
        }
    }

    const metrics = async () => {
        const value = await metricsCached()
        if (!samplerReady) metricsCached.reset()
        return value
    }

    return { overview, system, users, listUsers, getUser, autopilot, activity, tasks, cache, metrics }
}
