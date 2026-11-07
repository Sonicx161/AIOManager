/**
 * Dev-only Dashboard API mock. Installed only when BOTH import.meta.env.DEV is
 * true and localStorage 'aiomAdminMock' === '1'; production builds never import
 * it (the only importer is a dynamic import behind the same guard in
 * DashboardPage). Fixtures are the exact final contract shapes (raw values, no
 * server-side labels) so the mock and the server cannot drift; the contract test
 * pins them against the client types in admin.ts.
 */
import {
    mapAdmin,
    type AdminStatusRaw,
    type SessionIssuedRaw,
    type AdminSessionsRaw,
    type AuditPageRaw,
    type AuditVerifyRaw,
    type OverviewRaw,
    type SystemRaw,
    type MetricsRaw,
    type UsersPageRaw,
    type UserDetailRaw,
    type AutopilotRaw,
    type ActivityEngineRaw,
    type TasksRaw,
    type CacheRaw,
    type SettingsRaw,
    type SettingRowRaw,
    type LogsPageRaw,
    type LogLineRaw,
    type LogsStreamHandlers,
} from './admin.ts'
import { adminSeamAllowed, setAdminTransport, type AdminTransport } from './admin-transport.ts'
import type { RepairHistoryRowRaw } from './admin.ts'

const DEMO_SETUP_TOKEN = 'setup-demo-token'
const DEMO_USERNAME = 'admin'
const DEMO_PASSWORD = 'dashboard'

const MIN = 60_000
const HOUR = 60 * MIN
const now = () => Date.now()

interface MockUser {
    handle: string
    firstSeenMonth: string
    lastSeenDay: string
    inactiveDays: number
    connections: Record<string, number>
    rules: { total: number; active: number }
    storageBytes: number
    status: 'active' | 'disabled' | 'deleted'
    restoreUntil?: string
}

/** Session flags survive reloads (fixtures reset); key lives in sessionStorage only. */
const MOCK_STATE_KEY = 'aiomAdminMockState'

function readPersisted(): { signedIn?: boolean; setupRequired?: boolean; setupAvailable?: boolean; rememberedBrowser?: boolean } {
    try {
        return JSON.parse(sessionStorage.getItem(MOCK_STATE_KEY) ?? '{}') as { signedIn?: boolean; setupRequired?: boolean; setupAvailable?: boolean; rememberedBrowser?: boolean }
    } catch {
        return {}
    }
}

function persistSession(): void {
    try {
        sessionStorage.setItem(MOCK_STATE_KEY, JSON.stringify({ signedIn: state.signedIn, setupRequired: state.setupRequired, setupAvailable: state.setupAvailable, rememberedBrowser: state.rememberedBrowser }))
    } catch {
        // storage unavailable: mock state stays in memory only
    }
}

const state = {
    signedIn: readPersisted().signedIn ?? false,
    setupRequired: readPersisted().setupRequired ?? true,
    setupAvailable: readPersisted().setupAvailable ?? true,
    rememberedBrowser: readPersisted().rememberedBrowser ?? false,
    cachePrunes: 0,
    repairSeq: 41,
    logs: buildMockLogs(),
    logSeq: 60,
}

/** The server's USER_FILTERS (reads.js), mirrored row for row. */
function mockUserFilter(filter: string): (u: MockUser) => boolean {
    switch (filter) {
        case 'active': return u => u.inactiveDays < 30 && u.status !== 'deleted'
        case 'active-today': return u => u.inactiveDays === 0 && u.status !== 'deleted'
        case 'active-7d': return u => u.inactiveDays < 7 && u.status !== 'deleted'
        case 'inactive':
        case 'inactive-180': return u => u.inactiveDays >= 180
        case 'with-rules': return u => u.rules.total > 0
        case 'with-failover': return u => u.rules.active > 0
        case 'disabled': return u => u.status === 'disabled'
        case 'deleted': return u => u.status === 'deleted'
        default: return u => u.status !== 'deleted'
    }
}

/** Repair history is append-state: every run the mock audited stays in the feed. */
let mockHistoryDb: RepairHistoryRowRaw[] | null = null
function historyDb(): RepairHistoryRowRaw[] {
    if (!mockHistoryDb) mockHistoryDb = mockRepairHistory()
    return mockHistoryDb
}

/**
 * ~60 realistic REDACTED lines across the last 6 h in the ring's allowlist
 * style: instance-level templates keep their text, per-account lines carry the
 * fixed "details hidden" marker with class and code only.
 */
function buildMockLogs(): LogLineRaw[] {
    const TOTAL = 60
    const SPACING = 6 * MIN
    const lines: LogLineRaw[] = []
    const at = (i: number) => new Date(now() - (TOTAL - i) * SPACING).toISOString()
    let seq = 0
    const add = (level: LogLineRaw['level'], module: string, message: string) => { lines.push({ seq: ++seq, at: at(seq - 1), level, module, message }) }
    const ERRORS: [string, string][] = [
        ['sync', 'Sync pull failed: details hidden (HttpError, ECONNRESET)'],
        ['sync', 'Sync pull failed: details hidden (HttpError, ECONNRESET)'],
        ['autopilot', 'Failover commit failed: details hidden (Error, SQLITE_BUSY)'],
        ['image-proxy', 'Image fetch failed: details hidden (TimeoutError, ETIMEDOUT)'],
        ['sync', 'Sync pull failed: details hidden (HttpError, ECONNRESET)'],
        ['dashboard', 'details hidden (RateLimitError, HTTP 429)'],
        ['autopilot', 'Failover commit failed: details hidden (Error, SQLITE_BUSY)'],
        ['image-proxy', 'Image fetch failed: details hidden (TimeoutError, ETIMEDOUT)'],
        ['sync', 'Sync pull failed: details hidden (HttpError, ECONNRESET)'],
        ['dashboard', 'details hidden (RateLimitError, HTTP 429)'],
    ]
    const WARNS: [string, string][] = [
        ['image-proxy', 'Queue at 547 of 600 slots (91%)'],
        ['db', 'Pool at 18 of 20 connections (90%), median 42 ms'],
        ['autopilot', 'Write tripwire at 82% of the hourly statement budget; safe mode below 100%'],
        ['image-proxy', 'Queue at 561 of 600 slots (94%)'],
    ]
    const INFOS: [string, string][] = [
        ['sync', 'Pull applied in 84 ms'],
        ['dashboard', 'Sign-in succeeded via password from [ip]'],
        ['db', 'VACUUM complete.'],
        ['autopilot', 'Cycle finished: 500 rules in 41 s, no budget hit'],
        ['http', 'GET /api/sync/pull 200, [ip], query stripped'],
        ['activity', 'details hidden'],
        ['server', 'Startup: WAL checkpoint completed - cleared stale locks.'],
        ['sync', 'Pull pushed in 61 ms'],
    ]
    let e = 0, w = 0, f = 0
    for (let i = 0; i < TOTAL; i++) {
        if (i % 7 === 3 && e < ERRORS.length) { const [m, msg] = ERRORS[e++]; add('error', m, msg); continue }
        if (i % 11 === 5 && w < WARNS.length) { const [m, msg] = WARNS[w++]; add('warn', m, msg); continue }
        const [m, msg] = INFOS[f % INFOS.length]
        f++
        add('info', m, msg)
    }
    return lines
}

/** The stable, non-reversible per-account label; the full id never appears. */
function mockHandle(seed: string): string {
    return 'acct-' + seed
}

export const mockFixtures = {
    status(): AdminStatusRaw {
        return { enabled: true, setupRequired: state.setupRequired, setupAvailable: state.setupAvailable, signedIn: state.signedIn, readOnlyReplica: false, rememberedBrowser: state.rememberedBrowser }
    },

    sessionIssued(): SessionIssuedRaw {
        return { csrf: 'mock-csrf', expiresAt: now() + 8 * HOUR, idleExpiresAt: now() + 30 * MIN }
    },

    sessions(): AdminSessionsRaw {
        return {
            items: [
                { id: 'a1b2c3d4e5f60718', current: true, createdAt: now() - 52 * MIN, lastSeenAt: now() - 4_000, expiresAt: now() + 8 * HOUR - 52 * MIN, ipPrefix: '86.14.0.0/24', uaFamily: 'Chrome on Windows' },
                { id: 'b2c3d4e5f6071819', current: false, createdAt: now() - 26 * HOUR, lastSeenAt: now() - 14 * MIN, expiresAt: now() + 2 * HOUR, ipPrefix: '86.14.0.0/24', uaFamily: 'Firefox on Linux' },
                { id: 'c3d4e5f607181920', current: false, createdAt: now() - 9 * 24 * HOUR, lastSeenAt: now() - 9 * 24 * HOUR, expiresAt: now() - 8 * HOUR, ipPrefix: '79.12.0.0/24', uaFamily: 'Safari on iPhone' },
            ],
        }
    },

    users(): UsersPageRaw {
        const rows: MockUser[] = usersDb()
        return {
            rows: rows.map(mockUserRow),
            cursor: null,
            total: rows.length,
            filters: { accounts: 214, syncedToday: 41, active7d: 96, inactive180: 3 },
            bulkCap: 25,
            computedAt: now(),
        }
    },

    userDetail(handle?: string): UserDetailRaw {
        const u = (handle ? usersDb().find(x => x.handle === handle) : undefined) ?? usersDb()[0]
        return {
            ...mockUserRow(u),
            repairs: mockRepairCatalog(u.status),
            actionsAvailable: u.status !== 'deleted',
            computedAt: now(),
        }
    },

    repairsFeed(handle?: string) {
        const u = (handle ? usersDb().find(x => x.handle === handle) : undefined) ?? usersDb()[0]
        return { repairs: mockRepairCatalog(u.status), history: historyDb().slice(0, 20) }
    },

    overview(): OverviewRaw {
        return {
            verdict: 'watch',
            kpis: {
                accounts: 214,
                active7d: 96,
                active30d: 138,
                rulesActive: 1031,
                connections: { stremio: 244, hydra: 18, nuvio: 61 },
                failovers24h: 14,
                uptimeSec: 12 * 86_400 + 6 * 3600 + 41 * 60,
                dbSizeBytes: 46.2 * 1024 * 1024 * 1024,
                version: '2.1.0',
                adminSessions: 3,
            },
            signals: [
                { severity: 'watch', key: 'cache-hit-rate', text: 'Metadata cache hit rate 71%, below its 85% median.' },
                { severity: 'info', key: 'activity-breaker', text: '2 connection(s) are backing off in the activity scanner.' },
            ],
            recentAudit: [
                { seq: 12, at: new Date(now() - 9 * MIN).toISOString(), event: 'login.success', action: 'Sign-in succeeded', detail: 'via password, Chrome on Windows', hashPrefix: '9f2c3a11' },
                { seq: 11, at: new Date(now() - 14 * MIN).toISOString(), event: 'repair.run', action: 'Repair run', detail: 'acct-4de8a1b72c09: sync lock released, reason "push stuck 3 h", user notified', hashPrefix: '4de89012' },
                { seq: 10, at: new Date(now() - 22 * MIN).toISOString(), event: 'setting.update', action: 'Setting changed', detail: 'REGISTRATIONS_CLOSED: off to on', hashPrefix: 'b310774e' },
                { seq: 9, at: new Date(now() - 31 * MIN).toISOString(), event: 'session.revoke', action: 'Session revoked', detail: 'Firefox on Linux, dashboard initiated', hashPrefix: 'c07d19aa' },
                { seq: 8, at: new Date(now() - 2 * HOUR).toISOString(), event: 'account.disable', action: 'Account disabled', detail: 'acct-0d44e5c21b8a, reason "owner request", user notified', hashPrefix: '0d44e5c2' },
            ],
            guarantees: [
                'The Dashboard manages this instance, never the people on it.',
                'It cannot read addon lists, watch history, vault entries, credentials, rules or synced data.',
                'It cannot sign in as a user, export user data or show unredacted logs.',
                'Secrets are shown only as Set or Not set.',
                'Deleting an account is soft, needs a written reason and typed confirmation, and the user is notified.',
                'Every Dashboard action is written to a hash-chained audit log that the Dashboard cannot edit or clear.',
            ],
            dashboardStartedAt: now() - 3 * HOUR,
            computedAt: now(),
        }
    },

    system(): SystemRaw {
        const t0 = now() - 59 * MIN
        const history = Array.from({ length: 60 }, (_, i) => ({
            t: t0 + i * MIN,
            rssMb: 380 + Math.round(18 * Math.sin(i / 7)) + (i % 5),
            heapUsedMb: 240 + Math.round(12 * Math.sin(i / 9)) + (i % 4),
            loopP99Ms: Math.round((3 + (i % 4)) * 10) / 10,
            proxyQueue: 40 + (i % 7) * 3,
        }))
        return {
            version: '2.1.0',
            mode: 'multi-tenant',
            readOnly: false,
            node: 'v22.15.0',
            platform: 'linux',
            uptimeSec: 12 * 86_400 + 6 * 3600 + 41 * 60,
            startedAt: now() - (12 * 86_400 + 6 * 3600 + 41 * 60) * 1000,
            memory: { rssMb: 402, heapUsedMb: 249, heapTotalMb: 412, externalMb: 4 },
            eventLoop: { p50Ms: 0.3, p99Ms: 11.2, maxMs: 38.4 },
            database: { type: 'postgres', healthy: true, sizeBytes: Math.round(46.2 * 1024 ** 3), freeBytes: Math.round(3.1 * 1024 ** 3), walBytes: 84 * 1024 * 1024 },
            history,
            // Realistic environment payload (DP-13); disk facts stay out on purpose:
            // the metric card and the Storage bar already own them.
            environment: {
                os: 'Ubuntu 24.04.1 LTS',
                cpuModel: 'Intel Xeon E-2388G',
                cpuCores: 8,
                totalMemBytes: 32 * 1024 ** 3,
                timezone: 'Europe/Berlin (UTC+01:00)',
                node: 'v22.15.0',
                arch: 'x64',
                container: { detected: true, runtime: 'docker', runtimeVersion: '27.2.0' },
                db: { engine: 'postgres', version: '16.4' },
                dataDir: '/app/data',
                build: { commit: 'bc60aef7', date: '2026-11-03T09:12:00Z' },
            },
            computedAt: now(),
        }
    },

    /** Same numbers the real sampler produces for a quiet healthy host. */
    metrics(): MetricsRaw {
        const t0 = now() - 59 * MIN
        const series = Array.from({ length: 60 }, (_, i) => ({
            t: t0 + i * MIN,
            cpuPct: Math.round((14 + 9 * Math.sin(i / 6) + 6 * Math.sin(i / 2.3) + (i >= 45 && i <= 49 ? 16 : 0)) * 10) / 10,
            memUsedPct: Math.round((64 + i * 0.08 + 1.5 * Math.sin(i / 9)) * 10) / 10,
            rssMb: Math.round(386 + 16 * Math.sin(i / 7) + (i % 5)),
            heapMb: Math.round(242 + 11 * Math.sin(i / 9) + (i % 4)),
            loopP99Ms: Math.round((3.2 + 2.1 * Math.abs(Math.sin(i / 5)) + (i === 47 ? 38 : 0)) * 10) / 10,
            reqCount: Math.round(34 + 12 * Math.sin(i / 4.2) + (i % 3) * 4),
            errCount: i === 47 ? 9 : (i % 11 === 0 ? 2 : i % 7 === 0 ? 1 : 0),
        }))
        const dbMain = Math.round(46.2 * 1024 ** 3)
        return {
            sampledEveryMs: MIN,
            now: {
                t: now(),
                cpuPct: 23.4,
                cpuWindowMs: 41_000,
                loadavg: [1.24, 0.98, 0.71],
                memUsedBytes: Math.round(11.52 * 1024 ** 3),
                memTotalBytes: Math.round(17.18 * 1024 ** 3),
                memUsedPct: 67.1,
                rssMb: 402,
                heapUsedMb: 249,
                heapTotalMb: 412,
                loopP50Ms: 0.3,
                loopP99Ms: 11.2,
                uptimeSec: 12 * 86_400 + 6 * 3600 + 41 * 60,
                hostUptimeSec: 30 * 86_400,
                requestsTotal: 2333,
                errorsTotal: 29,
            },
            series,
            db: { type: 'postgres', healthy: true, mainBytes: dbMain, walBytes: 84 * 1024 * 1024, shmBytes: null, totalBytes: dbMain + 84 * 1024 * 1024 },
            disk: { available: true, freeBytes: Math.round(118.4 * 1024 ** 3), totalBytes: Math.round(460.2 * 1024 ** 3), usedPct: 74.3 },
            workers: {
                autopilot: { enabled: true, running: false, lastCycle: { endedAt: now() - 42_000, error: null } },
                activity: { enabled: true, running: false, lastCycle: { endedAt: now() - 6 * MIN, error: null } },
            },
            limits: { points: 60, sampledEveryMs: MIN, window: 'One point per sample; the ring keeps the last 60 points (about one hour).' },
            notes: {
                sampling: 'Sampled in memory by a background timer. Reading this endpoint writes nothing to the database.',
                cpu: 'Busy share of CPU time between two samples; null until the second sample.',
                loadavg: 'Reported only where the platform provides non-zero values.',
                db: 'SQLite sizes are the main file plus WAL and SHM; PostgreSQL reports the database size.',
                disk: 'Free and total bytes of the filesystem holding the data directory.',
            },
            computedAt: now(),
        }
    },

    autopilot(): AutopilotRaw {
        return {
            worker: {
                running: false,
                intervalMs: 60_000,
                lastRunAt: now() - 41_000,
                lastCycleEndedAt: now() - 39_000,
                lastCycle: { scanned: 500, budgetHit: false, durationMs: 41_200 },
                recheckMs: 30_000,
                cycleBudgetMs: 120_000,
                disabledReason: null,
            },
            rules: {
                total: 1248,
                active: 1031,
                automatic: 310,
                byPlatform: { stremio: { total: 902, active: 748 }, nuvio: { total: 231, active: 192 }, realstream: { total: 115, active: 91 } },
            },
            failovers24h: { 'service-down': 11, 'token-refresh': 3 },
            tripwire: {
                enabled: true,
                statementsLastHour: 412,
                bytesLastHour: 18.2 * 1024 * 1024,
                limits: { statements: 3000, bytes: 300 * 1024 * 1024 },
                activeRules: 1031,
                safeMode: null,
            },
            caches: { health: { entries: 1248 } },
            computedAt: now(),
        }
    },

    activityEngine(): ActivityEngineRaw {
        return {
            enabled: true,
            running: false,
            lastCycle: {
                skipped: false,
                startedAt: now() - 6 * MIN,
                durationMs: 2_140,
                accountsScanned: 36,
                accountsSkippedByHash: 2,
                accountsSkippedByBreaker: 3,
                eventsWritten: 128,
                snapshotWrites: 31,
                snapshotDeletes: 4,
                budgetExhausted: false,
            },
            breakerEntries: 2,
            config: { enabled: true, intervalMs: 5 * MIN, jitterMs: 20_000, maxAccountsPerCycle: 50 },
            scope: 'Server-side activity capture scans Stremio connections only. Nuvio, RealStream and Hydra activity is tracked by the app on the device.',
            computedAt: now(),
        }
    },

    tasks(): TasksRaw {
        return {
            items: [
                { id: 'autopilot-worker', label: 'Autopilot health cycle', intervalMs: 60_000, enabled: true, running: false, lastRunAt: now() - 41_000, idempotent: false },
                { id: 'activity-scan', label: 'Activity scan (Stremio only)', intervalMs: 5 * MIN, enabled: true, running: false, lastRunAt: now() - 6 * MIN, idempotent: true },
                { id: 'metadata-cache-cleanup', label: 'Metadata cache cleanup', intervalMs: HOUR, enabled: true, running: false, lastRunAt: now() - 23 * MIN, idempotent: true },
                { id: 'dashboard-sampler', label: 'Dashboard system sampler (memory only)', intervalMs: MIN, enabled: true, running: false, lastRunAt: now() - 9_000, idempotent: true },
            ],
            runNowAvailable: false,
            computedAt: now(),
        }
    },

    cache(): CacheRaw {
        return {
            layers: [
                {
                    id: 'metadata',
                    label: 'Metadata cache (memory + database)',
                    l1_entries: 8210,
                    l1_max_entries: 10_000,
                    l1_bytes: 112 * 1024 * 1024,
                    l1_max_bytes: 256 * 1024 * 1024,
                    l1_utilization_pct: 82.1,
                    l1_evictions_total: 12,
                    l2_rows: 41_905,
                    l2_expired_pending: 318,
                    pending_requests: 3,
                    dedup_hits_total: 1_204,
                    l1_hits_total: 88_412,
                    l2_hits_total: 31_008,
                    misses_total: 12_910,
                    stale_served_total: 0,
                    overall_hit_rate_pct: 71.4,
                    db_inserts_total: 41_905,
                    db_deletes_total: 812,
                    db_updates_total: 1_503,
                    last_cleanup_deleted: 480,
                    last_cleanup_at: now() - 23 * MIN,
                },
                { id: 'sync-response', label: 'Sync response cache', hits: 1_812, misses: 247, stores: 1_203, evictions: 34, itemSkips: 2, invalidations: 12, entries: 214, totalBytes: 48 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 },
                { id: 'rules', label: 'Autopilot rule cache', entries: 1248 },
                { id: 'rule-decrypt', label: 'Autopilot rule decrypt cache', entries: 310 },
                { id: 'health', label: 'Addon health cache', entries: 1248 },
                { id: 'auth', label: 'Sign-in verification cache', entries: 57 },
            ],
            proxyQueue: { length: 492, max: 600, active: 4, concurrency: 12, distinctKeys: 181, busiestKeyCount: 9 },
            clearAvailable: false,
            computedAt: now(),
        }
    },

    settings(): SettingsRaw {
        const row = (r: Partial<SettingRowRaw> & Pick<SettingRowRaw, 'key' | 'label' | 'type' | 'summary'>): SettingRowRaw => ({
            more: '', source: 'default', apply: 'restart', envOnly: false, restartPending: false, stored: false, ...r,
        })
        const lock = 'Read before the database opens.'
        return {
            precedence: ['env', 'here', 'default'],
            groups: [
                {
                    id: 'essential', title: 'Essential setup', note: null,
                    rows: [
                        row({ key: 'PORT', label: 'Port', type: 'number', summary: 'Port the server listens on (bound to 0.0.0.0).', source: 'env', value: '16150', default: '1610', min: 1, max: 65535, canAdopt: true }),
                        row({ key: 'NODE_ENV', label: 'Runtime mode', type: 'select', summary: 'Runtime mode.', options: ['production', 'development'], source: 'env', value: 'production', default: 'production', canAdopt: true }),
                        row({ key: 'DATA_DIR', label: 'Data directory', type: 'text', summary: 'Directory for the SQLite database.', source: 'env', envOnly: true, envOnlyReason: lock, value: '/app/data', default: '<server>/data' }),
                        row({ key: 'MAX_SYNC_PAYLOAD_SIZE', label: 'Max sync payload', type: 'number', summary: 'Maximum size of the encrypted sync-state blob.', unit: { label: 'MB', factor: 1048576 }, min: 1, value: '104857600', default: '104857600' }),
                    ],
                },
                {
                    id: 'security', title: 'Security', note: null,
                    rows: [
                        row({ key: 'ENCRYPTION_KEY', label: 'Encryption key', type: 'secret', summary: 'Encrypts sensitive data at rest.', source: 'env', envOnly: true, envOnlyReason: 'Encrypts the database.', set: true }),
                        row({ key: 'CUSTOM_HTML', label: 'Custom sign-in HTML', type: 'longtext', summary: 'Raw HTML at the top of the sign-in page.', apply: 'live', value: null, default: null }),
                        row({ key: 'REGISTRATIONS_CLOSED', label: 'Close registrations', type: 'boolean', summary: 'Block new account creation.', apply: 'live', value: 'false', default: 'false' }),
                    ],
                },
                {
                    id: 'autopilot', title: 'Autopilot engine', note: null,
                    rows: [
                        row({ key: 'AUTOPILOT_RULE_RECHECK_MS', label: 'Rule recheck interval', type: 'number', summary: 'Minimum interval before a rule is re-evaluated.', unit: { label: 's', factor: 1000 }, min: 10000, source: 'here', stored: true, value: '60000', default: '30000', restartPending: true }),
                        row({ key: 'AUTOPILOT_TRIPWIRE_WEBHOOK_URL', label: 'Tripwire alert webhook', type: 'secret', summary: 'Optional hoster alert when the tripwire trips.', set: true, source: 'here', stored: true }),
                    ],
                },
            ],
            readOnly: false,
            restartPending: 1,
            computedAt: now(),
        }
    },

    audit(): AuditPageRaw {
        const rows = mockAuditRows()
        return {
            rows,
            cursor: null,
            retentionNote: 'Append-only and hash-chained. The Dashboard cannot edit or clear it; the verifier reports a broken chain instead of hiding it.',
        }
    },

    auditVerify(): AuditVerifyRaw {
        return { ok: true, rows: 12, verifiedAt: new Date().toISOString(), head: '9f2c3a11' + '0'.repeat(56) }
    },

    logs(): LogsPageRaw {
        return logsPageRaw(new URL('http://mock.local/api/admin/logs'))
    },
}

interface MockUser {
    handle: string
    firstSeenMonth: string
    lastSeenDay: string
    inactiveDays: number
    connections: Record<string, number>
    rules: { total: number; active: number }
    storageBytes: number
    status: 'active' | 'disabled' | 'deleted'
    restoreUntil?: string
}

/** The mock's repair catalog mirrors server/admin/reads.js, labels included. */
const MOCK_AVAILABLE_REPAIRS = new Set(['clear-login-backoff', 'release-sync-lease', 'clear-server-caches', 'reset-activity-breaker'])

/** Account rows are mutable: operator actions flip status and the list refetches. */
let mockUsersDb: MockUser[] | null = null

function usersDb(): MockUser[] {
    if (!mockUsersDb) {
        mockUsersDb = [
            { handle: mockHandle('61bb8c2210aa'), firstSeenMonth: '2025-08', lastSeenDay: today(), inactiveDays: 0, connections: { stremio: 2, hydra: 1 }, rules: { total: 12, active: 10 }, storageBytes: 18 * 1024 * 1024, status: 'active' },
            { handle: mockHandle('9490d1e44f02'), firstSeenMonth: '2025-09', lastSeenDay: today(), inactiveDays: 0, connections: { stremio: 1 }, rules: { total: 3, active: 3 }, storageBytes: 6 * 1024 * 1024, status: 'active' },
            { handle: mockHandle('793f02ba7711'), firstSeenMonth: '2026-01', lastSeenDay: today(), inactiveDays: 0, connections: { stremio: 2 }, rules: { total: 0, active: 0 }, storageBytes: 4 * 1024 * 1024, status: 'active' },
            { handle: mockHandle('05a1c3d9ee44'), firstSeenMonth: '2025-05', lastSeenDay: yesterday(), inactiveDays: 1, connections: { stremio: 2 }, rules: { total: 44, active: 40 }, storageBytes: 31 * 1024 * 1024, status: 'disabled' },
            { handle: mockHandle('773ab4e5ff55'), firstSeenMonth: '2026-03', lastSeenDay: yesterday(), inactiveDays: 1, connections: { stremio: 1 }, rules: { total: 1, active: 1 }, storageBytes: 2 * 1024 * 1024, status: 'active' },
            { handle: mockHandle('44ad56f70066'), firstSeenMonth: '2025-08', lastSeenDay: dayIso(2), inactiveDays: 2, connections: { stremio: 1 }, rules: { total: 7, active: 6 }, storageBytes: 9 * 1024 * 1024, status: 'active' },
            { handle: mockHandle('e2e667a81177'), firstSeenMonth: '2026-06', lastSeenDay: dayIso(4), inactiveDays: 4, connections: { nuvio: 1 }, rules: { total: 0, active: 0 }, storageBytes: 1024 * 1024, status: 'active' },
            { handle: mockHandle('8b2278b92288'), firstSeenMonth: '2026-10', lastSeenDay: dayIso(5), inactiveDays: 5, connections: { stremio: 1 }, rules: { total: 2, active: 2 }, storageBytes: 3 * 1024 * 1024, status: 'active' },
            { handle: mockHandle('b4f289ca3399'), firstSeenMonth: '2026-07', lastSeenDay: dayIso(29), inactiveDays: 29, connections: { stremio: 2 }, rules: { total: 5, active: 4 }, storageBytes: 5 * 1024 * 1024, status: 'active' },
            { handle: mockHandle('3c1d9adb4400'), firstSeenMonth: '2026-09', lastSeenDay: dayIso(180), inactiveDays: 181, connections: {}, rules: { total: 0, active: 0 }, storageBytes: 1024 * 1024, status: 'active' },
            { handle: mockHandle('8fe70aec5511'), firstSeenMonth: '2026-05', lastSeenDay: dayIso(210), inactiveDays: 210, connections: {}, rules: { total: 0, active: 0 }, storageBytes: 2 * 1024 * 1024, status: 'deleted', restoreUntil: new Date(now() + 29 * 24 * HOUR).toISOString() },
        ]
    }
    return mockUsersDb
}

function mockUserRow(u: MockUser) {
    return {
        handle: u.handle,
        firstSeenMonth: u.firstSeenMonth,
        lastSeenDay: u.lastSeenDay,
        inactiveDays: u.inactiveDays,
        connections: u.connections,
        rules: u.rules,
        storageBytes: u.storageBytes,
        status: u.status,
        restoreUntil: u.status === 'deleted' ? u.restoreUntil ?? null : null,
    }
}

/** Fixed-template user notices, mirroring server/admin/account-actions.js. */
const MOCK_NOTICES: Record<string, string> = {
    'account.disabled': "Your instance's Dashboard disabled your account.",
    'account.enabled': "Your instance's Dashboard re-enabled your account.",
    'account.deleted': "Your instance's Dashboard deleted your account. Data is kept.",
    'account.restored': "Your instance's Dashboard restored your account.",
    'account.signed_out': "Your instance's Dashboard signed out the devices for your account.",
    'repair.release-sync-lease': "Your instance's Dashboard cleared the sync server caches for your account.",
    'repair.clear-server-caches': "Your instance's Dashboard cleared server caches for your account. Some responses may be slower for a few minutes.",
    'repair.reset-activity-breaker': "Your instance's Dashboard reset the activity scan backoff for your account.",
    'repair.clear-login-backoff': "Your instance's Dashboard cleared the login backoff for your account.",
}

/** Dry-run plans per repair, in the server's exact response shape. */
const MOCK_REPAIR_PLANS: Record<string, { scope: string; matchCount: number; summary: string; samples: string[]; result: Record<string, number>; message: string }> = {
    'release-sync-lease': {
        scope: 'sync',
        matchCount: 3,
        summary: '2 cached sign-in entries and 1 cached sync response(s) would be cleared. There is no server-side sync lease.',
        samples: [],
        result: { syncResponseCache: 1, cachedAuth: 2 },
        message: 'Cleared the sync server caches for this account.',
    },
    'clear-server-caches': {
        scope: 'server',
        matchCount: 21,
        summary: '21 cache entries would be cleared (connection 2, canonical 5, rules 12, ruleDecrypt 3, syncResponse 1, cachedAuth 1). The addon health cache is shared and stays.',
        samples: ['connection', 'canonical', 'rules'],
        result: { connection: 2, canonical: 5, rules: 12, ruleDecrypt: 3, syncResponse: 1, cachedAuth: 1 },
        message: "Cleared the server caches for this account. Some responses may be slower for a few minutes.",
    },
    'reset-activity-breaker': {
        scope: 'activity',
        matchCount: 2,
        summary: '2 connection(s) backing off, longest backoff 14 min.',
        samples: [],
        result: { cleared: 2 },
        message: 'Reset the activity scan backoff for this account.',
    },
    'clear-login-backoff': {
        scope: 'login',
        matchCount: 1,
        summary: '1 connection(s) in login backoff or auth cooldown would be cleared (1 auth cooldown, 0 backoff).',
        samples: [],
        result: { cleared: 1 },
        message: 'Cleared the login backoff for this account.',
    },
}

function mockRepairCatalog(status: 'active' | 'disabled' | 'deleted' = 'active') {
    const row = (key: string, tier: 1 | 2, label: string, description?: string) => ({
        key,
        tier,
        label,
        available: tier === 1 && MOCK_AVAILABLE_REPAIRS.has(key) && status !== 'deleted',
        ...(description ? { description } : {}),
    })
    return [
        row('clear-login-backoff', 1, 'Clear login backoff'),
        row('release-sync-lease', 1, "Clear this account's sync server caches", 'There is no server-side sync lease to release. This clears the server\u2019s cached sync responses and cached sign-in entries for the account, so the next sign-in and sync pull do their full verification work again.'),
        row('clear-server-caches', 1, "Clear this account's server caches"),
        row('reset-activity-breaker', 1, 'Reset the activity scan breaker'),
        row('recheck-failover', 1, 'Re-run the Failover health check'),
        row('refresh-connection-token', 1, 'Force a connection token refresh'),
        row('purge-orphaned-state', 1, 'Purge orphaned server state'),
    ]
}

/** Four audited runs for the feed, newest first (at, repair, reason, counts). */
function mockRepairHistory(): RepairHistoryRowRaw[] {
    return [
        { seq: 41, at: new Date(now() - 26 * MIN).toISOString(), repair: 'release-sync-lease', reason: 'pushes looked stuck for three hours', counts: { syncResponseCache: 1, cachedAuth: 2 } },
        { seq: 32, at: new Date(now() - 2 * 24 * HOUR).toISOString(), repair: 'clear-server-caches', reason: 'stale canonical cache after the migration', counts: { connection: 2, canonical: 5, rules: 12 } },
        { seq: 21, at: new Date(now() - 9 * 24 * HOUR).toISOString(), repair: 'reset-activity-breaker', reason: 'scan stuck in backoff after the provider outage', counts: { cleared: 3 } },
        { seq: 8, at: new Date(now() - 21 * 24 * HOUR).toISOString(), repair: 'clear-login-backoff', reason: 'login loop after password rotation', counts: { cleared: 1 } },
    ]
}

const mockAuditRows = () => {
    const hashFor = (seq: number) => seq.toString(16).padStart(4, '0').repeat(16)
    const mk = (seq: number, isoAt: string, event: string, action: string, detail: string): AuditPageRaw['rows'][number] => ({
        seq,
        at: isoAt,
        event,
        action,
        detail,
        result: 'ok',
        actor: 'dashboard',
        device: 'Chrome on Windows',
        hash: hashFor(seq),
        prevHash: hashFor(seq - 1),
    })
    return [
        mk(12, new Date(now() - 9 * MIN).toISOString(), 'login.success', 'Sign-in succeeded', 'via password, Chrome on Windows'),
        mk(11, new Date(now() - 14 * MIN).toISOString(), 'repair.run', 'Repair run', 'acct-4de8a1b72c09: sync lock released, reason "push stuck 3 h", user notified'),
        mk(10, new Date(now() - 22 * MIN).toISOString(), 'setting.update', 'Setting changed', 'REGISTRATIONS_CLOSED: off to on'),
        mk(9, new Date(now() - 31 * MIN).toISOString(), 'session.revoke', 'Session revoked', 'Firefox on Linux, dashboard initiated'),
        mk(8, new Date(now() - 2 * HOUR).toISOString(), 'account.disable', 'Account disabled', 'acct-0d44e5c21b8a, reason "owner request", user notified'),
        mk(7, new Date(now() - 20 * HOUR).toISOString(), 'account.delete', 'Account soft deleted', 'acct-8fe70aec5511, reason "inactive 210 d", restorable for 30 days'),
        mk(6, new Date(now() - 21 * HOUR).toISOString(), 'cache.clear', 'Cache cleared', 'metadata layer, typed confirmation, 41,905 rows'),
        mk(5, new Date(now() - 22 * HOUR).toISOString(), 'login.fail', 'Sign-in failed', 'wrong username or password, backoff to 8 s'),
    ]
}

function today(): string {
    return new Date().toISOString().slice(0, 10)
}

function yesterday(): string {
    return new Date(now() - 24 * HOUR).toISOString().slice(0, 10)
}

function dayIso(daysAgo: number): string {
    return new Date(now() - daysAgo * 24 * HOUR).toISOString().slice(0, 10)
}

function json(res: unknown, status = 200): { status: number; body: string } {
    return { status, body: JSON.stringify(res) }
}

function err(status: number, message: string): { status: number; body: string } {
    return json({ error: message }, status)
}

function pushLogLine(level: LogLineRaw['level'], module: string, message: string): void {
    state.logSeq += 1
    state.logs.push({ seq: state.logSeq, at: new Date().toISOString(), level, module, message })
    if (state.logs.length > 1000) state.logs.shift()
}

/**
 * Server-cap mirrors (server/admin/log-ring.js) shared by GET /logs and the
 * export: the 256-character query cap, a compile-only regex check, and the
 * export's format allowlist. Each answers the server's 400 error shape.
 */
function logsQueryError(url: URL, { isExport = false } = {}): { status: number; body: string } | null {
    const p = url.searchParams
    if (isExport) {
        const format = p.get('format')
        if (format !== null && format !== 'log' && format !== 'ndjson') return err(400, 'format_invalid')
    }
    const q = p.get('q') ?? ''
    if (q.length > 256) return err(400, 'query_too_long')
    if (q && isRegexParam(p.get('regex'))) {
        // Compile-only check: the pattern is data, never executed here.
        try { new RegExp(q, 'i') } catch { return err(400, 'regex_invalid') }
    }
    return null
}

// Mirrors the server: regex=1 or regex=true, and the raw q is length-checked untrimmed.
const isRegexParam = (v: string | null): boolean => v === '1' || v === 'true'

/**
 * The DP-03 logs read over the mock ring: q (substring), regex=1, level,
 * module, since (epoch ms), cursor (seq of the oldest loaded line) and limit
 * (default 200, cap 500). Emulates the server contract so the screens and the
 * capture harness see real shapes, including modules and nextCursor.
 */
function logsFilterRaw(url: URL): LogLineRaw[] {
    const p = url.searchParams
    const all = state.logs
    let out = all
    const q = p.get('q') ?? ''
    const level = p.get('level')
    const module = p.get('module')
    const since = Number(p.get('since'))
    if (level && level !== 'all') out = out.filter(l => l.level === level)
    if (module && module !== 'all') out = out.filter(l => l.module === module)
    if (Number.isFinite(since) && since > 0) out = out.filter(l => Date.parse(l.at) >= since)
    if (q) {
        // No user regex ever runs over mock data (client-path ReDoS guard): a
        // valid pattern is matched as its literal pattern text, a deterministic
        // server-shaped result. Regex fidelity is the server's bounded engine's job.
        const needle = q.toLowerCase()
        out = out.filter(l => l.message.toLowerCase().includes(needle))
    }
    const cursor = Number(p.get('cursor'))
    if (Number.isFinite(cursor) && cursor > 0) out = out.filter(l => l.seq < cursor)
    return out
}

function logsPageRaw(url: URL): LogsPageRaw {
    const all = state.logs
    const levels: LogsPageRaw['levels'] = { all: all.length, info: 0, warn: 0, error: 0 }
    const modules = new Set<string>()
    for (const l of all) { levels[l.level]++; modules.add(l.module) }
    const out = logsFilterRaw(url)
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200))
    const page = out.slice(-limit)
    return {
        lines: page,
        levels,
        bufferSize: 1000,
        lastSeq: all.length ? all[all.length - 1].seq : 0,
        redaction: 'Redacted before storage: no bodies, headers, secrets or query strings; IPs are removed.',
        modules: [...modules].sort(),
        nextCursor: page.length && out.length > page.length ? page[0].seq : null,
    }
}

/** Export filter: the same pipeline with no page limit; newest 5000 kept, oldest first. */
function logsExportRaw(url: URL): LogLineRaw[] {
    return logsFilterRaw(url).slice(-5000)
}

let logTimer: ReturnType<typeof setInterval> | null = null

function startLogTicker(): void {
    if (logTimer) return
    const pool: [LogLineRaw['level'], string, string][] = [
        ['info', 'sync', 'Pull applied in 81 ms'],
        ['info', 'http', 'GET /api/sync/pull 200, [ip], query stripped'],
        ['warn', 'image-proxy', 'Queue at 493 of 600 slots (82%)'],
        ['info', 'autopilot', 'Cycle finished: 500 rules in 40 s, no budget hit'],
        ['info', 'db', 'Pool 6 of 20 connections in use, 12 ms median'],
    ]
    logTimer = setInterval(() => {
        const [level, module, message] = pool[Math.floor(Math.random() * pool.length)]
        pushLogLine(level, module, message)
    }, 2500)
}

const transport: AdminTransport = {
    async fetch(path, init) {
        const method = init.method ?? 'GET'
        const url = new URL(path, 'http://mock.local')
        const parts = url.pathname.split('/').filter(Boolean) // api, admin, ...
        const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
        await new Promise(r => setTimeout(r, 60))
        // An aborted caller (React Query cancelled the request) must see the
        // same silent AbortError the real fetch would raise, not a result.
        if (init.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError')

        if (parts[1] !== 'admin') return err(404, 'Not found')
        const seg = parts.slice(2) // after api/admin

        if (seg[0] === 'status' && method === 'GET') return json(mockFixtures.status())

        if (seg[0] === 'setup' && method === 'POST') {
            if (!state.setupAvailable || !state.setupRequired) { return err(409, 'Dashboard setup is not available') }
            if (body.setupToken !== DEMO_SETUP_TOKEN) return err(401, 'Invalid credentials')
            if (typeof body.username !== 'string' || !body.username.trim()) return err(400, 'Username is required')
            if (body.password !== body.confirmPassword) return err(400, 'Passwords do not match')
            if (typeof body.password !== 'string' || body.password.length < 14) return err(400, 'Use at least 14 characters')
            state.setupRequired = false
            state.setupAvailable = false
            state.signedIn = true
            state.rememberedBrowser = body.remember === true
            persistSession()
            return json(mockFixtures.sessionIssued())
        }

        if (seg[0] === 'login' && method === 'POST') {
            if (String(body.username ?? '').trim().toLowerCase() !== DEMO_USERNAME || body.password !== DEMO_PASSWORD) return err(401, 'Username or password is incorrect.')
            state.signedIn = true
            state.rememberedBrowser = body.remember === true
            persistSession()
            return json(mockFixtures.sessionIssued())
        }

        if (!state.signedIn) return err(401, 'Session expired')

        switch (seg[0]) {
            case 'logout':
                state.signedIn = false
                persistSession()
                return json({ ok: true })
            case 'session':
                return json(mockFixtures.sessionIssued())
            case 'sessions': {
                if (method === 'DELETE' && seg[1]) {
                    return json({ ok: true, revoked: true })
                }
                if (seg[1] === 'revoke-all') {
                    state.signedIn = false
                    state.rememberedBrowser = false
                    persistSession()
                    return json({ ok: true, revoked: 3 })
                }
                return json(mockFixtures.sessions())
            }
            case 'overview':
                return json(mockFixtures.overview())
            case 'system':
                return json(mockFixtures.system())
            case 'metrics':
                return json(mockFixtures.metrics())
            case 'users': {
                if (seg.length === 1) {
                    const p = url.searchParams
                    // The server's strict handle-prefix search: lowercase acct- hex
                    // prefix, anything else answers the fixed 400.
                    let q: string | null = p.get('q')
                    if (q === '') q = null
                    if (q !== null) {
                        q = q.toLowerCase()
                        if (!/^acct-[0-9a-f]{0,12}$/.test(q)) return err(400, 'query_invalid')
                    }
                    const matchesFilter = mockUserFilter(p.get('filter') ?? 'all')
                    let matched = q === null ? usersDb().filter(matchesFilter) : usersDb().filter(u => u.handle.startsWith(q as string))
                    if (q !== null) matched = matched.filter(matchesFilter)
                    const sortKey = p.get('sort') === 'created' ? 'firstSeenMonth' : 'lastSeenDay'
                    const direction = p.get('order') === 'asc' ? 1 : -1
                    matched = [...matched].sort((a, b) =>
                        direction * String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? '')) || a.handle.localeCompare(b.handle))
                    const limit = Math.min(100, Math.max(1, Number(p.get('limit')) || 50))
                    const start = Number(p.get('cursor')) || 0
                    const page = matched.slice(start, start + limit)
                    return json({
                        rows: page.map(mockUserRow),
                        cursor: start + limit < matched.length ? String(start + limit) : null,
                        total: matched.length,
                        filters: { accounts: 214, syncedToday: 41, active7d: 96, inactive180: 3 },
                        bulkCap: 25,
                        computedAt: now(),
                    })
                }
                if (seg[1] === 'bulk-delete') {
                    const candidates = () => usersDb().filter(u => u.inactiveDays >= 180 && u.status !== 'deleted').slice(0, 25)
                    if (method === 'GET') {
                        const expected = candidates().length
                        return json({ expected, setHash: `mock-${expected}-${Math.floor(now() / 60000)}`, cap: 25 })
                    }
                    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
                    if (reason.length < 3 || reason.length > 500) return err(400, 'A written reason (3-500 characters) is required')
                    const expected = candidates().length
                    if (body.confirm !== `DELETE ${expected}`) return json({ error: 'Count changed, confirm again', expected }, 409)
                    for (const u of candidates()) {
                        u.status = 'deleted'
                        u.restoreUntil = new Date(now() + 30 * 24 * HOUR).toISOString()
                    }
                    pushLogLine('info', 'dashboard', `Bulk soft delete of ${expected} account(s) audited, users notified`)
                    return json({ ok: true, deleted: expected, remaining: 0, cap: 25 })
                }
                const u = usersDb().find(x => x.handle === seg[1])
                if (!u) return err(404, 'Account not found')
                if (seg.length === 2) return json(mockFixtures.userDetail(u.handle))
                if (seg.length === 3 && seg[2] === 'repairs' && method === 'GET') {
                    return json(mockFixtures.repairsFeed(u.handle))
                }
                if (seg.length === 4 && seg[2] === 'repairs') {
                    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
                    if (reason.length < 3 || reason.length > 500) return err(400, 'A written reason (3-500 characters) is required')
                    const catalog = mockRepairCatalog(u.status)
                    const entry = catalog.find(r => r.key === seg[3])
                    if (!entry) return err(404, 'Unknown repair key.')
                    if (!entry.available) return err(404, 'This repair is not available on this instance.')
                    if (u.status === 'deleted') return err(409, 'account_deleted')
                    const plan = MOCK_REPAIR_PLANS[seg[3]]
                    const notice = MOCK_NOTICES[`repair.${seg[3]}`] ?? `repair.${seg[3]}`
                    if (body.dryRun === true) {
                        return json({ scope: plan.scope, matchCount: plan.matchCount, summary: plan.summary, samples: plan.samples, userNotice: notice })
                    }
                    state.repairSeq += 1
                    historyDb().unshift({ seq: state.repairSeq, at: new Date().toISOString(), repair: seg[3], reason, counts: plan.result })
                    pushLogLine('info', 'dashboard', `Repair ${seg[3]} on ${seg[1]}, reason "${reason}", user notified`)
                    return json({ ok: true, counts: plan.result, message: `${plan.message} The user sees: "${notice}"` })
                }
                if (seg.length === 3 && ['disable', 'enable', 'delete', 'restore', 'signout-devices'].includes(seg[2])) {
                    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
                    if (reason.length < 3 || reason.length > 500) return err(400, 'A written reason (3-500 characters) is required')
                    const words: Record<string, string> = { disable: 'DISABLE', enable: 'ENABLE', delete: 'DELETE', restore: 'RESTORE', 'signout-devices': 'SIGNOUT' }
                    if (body.confirm !== words[seg[2]]) return err(400, `Confirm with the exact word ${words[seg[2]]}.`)
                    const action = seg[2]
                    if (action === 'disable' || action === 'enable') {
                        if (u.status === 'deleted') return err(409, 'account_deleted')
                        u.status = action === 'disable' ? 'disabled' : 'active'
                    } else if (action === 'delete') {
                        if (u.status !== 'deleted') {
                            u.status = 'deleted'
                            u.restoreUntil = new Date(now() + 30 * 24 * HOUR).toISOString()
                        }
                    } else if (action === 'restore') {
                        if (u.status !== 'deleted') return err(409, 'account_not_deleted')
                        u.status = 'active'
                        u.restoreUntil = undefined
                    }
                    pushLogLine('info', 'dashboard', `${action} on ${seg[1]}, reason "${reason}", user notified`)
                    return json(action === 'signout-devices'
                        ? { ok: true, devices: 2, credentialEpoch: 3 }
                        : { ok: true, status: u.status, ...(u.restoreUntil ? { restoreUntil: u.restoreUntil } : {}) })
                }
                return err(404, 'Not found')
            }
            case 'autopilot':
                return json(mockFixtures.autopilot())
            case 'activity-engine':
                return json(mockFixtures.activityEngine())
            case 'tasks': {
                if (seg.length === 1) return json(mockFixtures.tasks())
                const job = mockFixtures.tasks().items.find(t => t.id === seg[1])
                if (!job) return err(404, 'Job not found')
                if (body.confirm !== 'RUN') return err(400, 'Type RUN to confirm')
                pushLogLine('info', 'dashboard', `${job.label} run from the dashboard`)
                return json({ ok: true })
            }
            case 'cache': {
                if (seg.length === 1) return json(mockFixtures.cache())
                const layer = mockFixtures.cache().layers.find(l => l.id === seg[1])
                if (!layer) return err(404, 'Layer not found')
                if (typeof body.confirm !== 'string' || !body.confirm.startsWith('CLEAR')) return err(400, 'Type CLEAR to confirm')
                state.cachePrunes += 1
                pushLogLine('info', 'dashboard', `Cache ${seg[1]} cleared, typed confirmation`)
                return json({ ok: true, cleared: 0 })
            }
            case 'logs': {
                if (seg.length === 1) {
                    const bad = logsQueryError(url)
                    if (bad) return bad
                    return json(logsPageRaw(url))
                }
                if (seg[1] === 'export') {
                    const bad = logsQueryError(url, { isExport: true })
                    if (bad) return bad
                    const cap = logsExportRaw(url)
                    const format = url.searchParams.get('format') === 'ndjson' ? 'ndjson' : 'log'
                    const body = format === 'ndjson'
                        ? cap.map(l => JSON.stringify(l)).join('\n')
                        : cap.map(l => `${l.at} ${l.level.padEnd(5)} [${l.module}] ${l.message} (seq ${l.seq})`).join('\n')
                    const day = new Date().toISOString().slice(0, 10)
                    return {
                        status: 200,
                        body: body ? `${body}\n` : '',
                        headers: {
                            'content-type': format === 'ndjson' ? 'application/x-ndjson; charset=utf-8' : 'text/plain; charset=utf-8',
                            'content-disposition': `attachment; filename="dashboard-logs-${day}.${format}"`,
                            'x-content-type-options': 'nosniff',
                        },
                    }
                }
                return err(404, 'Not found')
            }
            case 'settings': {
                const view = mockFixtures.settings()
                if (seg[1] === 'export') return json({ format: 'aiomanager-settings', version: 1, exportedAt: new Date(now()).toISOString(), values: { PORT: '16150' }, secretsLeftOut: ['ENCRYPTION_KEY', 'AUTOPILOT_TRIPWIRE_WEBHOOK_URL'] })
                if (seg[1] === 'adopt' && method === 'POST') return json({ ok: true, copied: Array.isArray(body.keys) ? body.keys.length : 0, settings: view })
                if (seg[1] === 'import' && method === 'POST') return json({ ok: true, applied: body.apply === true ? 1 : 0, changes: [{ key: 'LOG_LEVEL', label: 'Log level', from: 'info', to: 'warn', apply: 'live' }], rejected: [], skipped: [], ...(body.apply === true ? { settings: view } : {}) })
                if (method === 'PATCH') {
                    const changes = body.changes && typeof body.changes === 'object' ? body.changes as Record<string, unknown> : {}
                    if (!Object.keys(changes).length) return err(400, 'Nothing to save.')
                    return json({ ok: true, saved: Object.keys(changes).length, restartNeeded: [], settings: view })
                }
                return json(view)
            }
            case 'audit': {
                if (seg[1] === 'verify') return json(mockFixtures.auditVerify())
                return json(mockFixtures.audit())
            }
            default:
                return err(404, 'Not found')
        }
    },
    streamLogs(stream: { onLine: (line: never) => void; onOpen?: () => void; onError?: (error: Event, closed: boolean) => void }) {
        const handlers = stream as unknown as LogsStreamHandlers
        startLogTicker()
        handlers.onOpen?.()
        const timer = setInterval(() => {
            const last = state.logs[state.logs.length - 1]
            if (last) handlers.onLine(mapAdmin.logLine(last))
        }, 2500)
        return () => clearInterval(timer)
    },
}

let installed = false

/**
 * Dev-seam test hook: appends one line to the mock ring exactly like the
 * ticker does, so tests can seed past the page caps. No-op outside dev/test.
 */
export function pushMockLogLine(level: LogLineRaw['level'], module: string, message: string): void {
    if (!adminSeamAllowed()) return
    pushLogLine(level, module, message)
}

/** Install the mock transport. Dev + explicit localStorage flag only. */
export function installAdminMock(): void {
    if (!adminSeamAllowed()) return
    if (installed) return
    installed = true
    setAdminTransport(transport)
}
