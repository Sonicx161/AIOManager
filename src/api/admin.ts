/**
 * Typed client for the Dashboard API (final contract, ADMIN-BUILD-PLAN.md).
 * The server returns raw values (numbers, enums, ISO times); the mappers below
 * build every display label client-side so labels follow the viewer's time zone
 * and never go stale inside the 30-60 s server caches. Cookie session,
 * X-Admin-CSRF on non-GET, credentials included. A dev-only mock transport can
 * be installed from admin-mock.ts; it never ships.
 */

export const ADMIN_API_BASE = '/api/admin'

import { currentTransport, setAdminTransport, AdminApiError } from './admin-transport.ts'
import { getAdminCsrf, invalidateAdminCsrf, setAdminCsrf } from '../lib/admin-session.ts'
import { pickSettingUnit } from '../lib/admin-settings.ts'
import { logsExportName, logsQueryParams, type LogsRequestFilters } from '../lib/admin-logs.ts'
import {
    formatBytes, formatClock, formatCount, formatDateTime, formatDay, formatDurationMs,
    formatIntervalMs, formatMonth, relTime, formatUptime,
} from '../lib/admin-format.ts'
import type { SystemEnvironment } from '../lib/admin-diagnostics.ts'
import {
    errorRatePct, freeShareTone, samplingLabel, samplingWindowLabel, sparkAria,
    thresholdTone, workerFreshnessRows,
    type WorkerFreshnessRow,
} from '../lib/admin-metrics.ts'

export { setAdminTransport, AdminApiError, invalidateAdminCsrf }
export { adminSeamAllowed } from './admin-transport.ts'
export type { SystemEnvironment } from '../lib/admin-diagnostics.ts'

// ---------------------------------------------------------------------------
// Raw response types (final contract; keep in sync with server/admin/reads.js)
// ---------------------------------------------------------------------------

export interface AdminStatusRaw {
    enabled: boolean
    setupRequired: boolean
    setupAvailable: boolean
    signedIn: boolean
    /** True on a read-only replica: sign-in and writes are refused there. */
    readOnlyReplica?: boolean
    /** True when this browser holds a remembered known-device cookie. */
    rememberedBrowser?: boolean
}

export interface SessionIssuedRaw {
    csrf: string
    expiresAt: number
    idleExpiresAt: number
}

export interface AdminSessionsRaw {
    items: {
        id: string
        current: boolean
        createdAt: number
        lastSeenAt: number
        expiresAt: number
        ipPrefix: string | null
        uaFamily: string | null
    }[]
}

export interface AuditRowRaw {
    seq: number
    at: string
    event: string
    action: string
    detail: string
    result: string
    actor: string
    device: string | null
    hash: string
    prevHash: string
}

export interface AuditPageRaw {
    rows: AuditRowRaw[]
    cursor: string | null
    retentionNote: string
}

export interface AuditVerifyRaw {
    ok: boolean
    rows: number
    verifiedAt: string
    head: string | null
    brokenAt?: number
    reason?: 'hash' | 'link' | 'gap'
}

export interface OverviewRaw {
    verdict: 'ok' | 'watch' | 'action'
    kpis: {
        /** Null while the users read is failing; a users-unavailable signal explains it. */
        accounts: number | null
        active7d: number | null
        active30d: number | null
        rulesActive: number | null
        connections: Record<string, number> | null
        failovers24h: number | null
        uptimeSec: number
        dbSizeBytes: number | null
        version: string
        adminSessions: number | null
    }
    signals: { severity: 'action' | 'watch' | 'info'; key: string; text: string }[]
    recentAudit: { seq: number; at: string; event: string; action: string; detail: string; hashPrefix: string }[]
    guarantees: string[]
    /** Present on older servers; the UI never depends on it. */
    dashboardStartedAt?: number
    computedAt: number
}

/**
 * Host and build facts for the System environment cards (DP-13). Computed
 * locally by the server, cached for the process lifetime; the data folder path
 * carries a ~ in place of any home-directory segment. Absent on older servers.
 */
export interface EnvironmentRaw {
    os: string | null
    cpuModel: string | null
    cpuCores: number | null
    totalMemBytes: number | null
    timezone: string | null
    node: string | null
    arch: string | null
    container: { detected: boolean; runtime: string | null; runtimeVersion: string | null } | null
    db: { engine: string; version: string | null } | null
    dataDir: string | null
    build: { commit: string | null; date: string | null } | null
}

export interface SystemRaw {
    version: string
    mode: string
    readOnly: boolean
    node: string
    platform: string
    uptimeSec: number
    startedAt: number
    memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number }
    eventLoop: { p50Ms: number; p99Ms: number; maxMs: number } | null
    database: { type: string; healthy: boolean; sizeBytes: number | null; freeBytes: number | null; walBytes: number | null }
    history: { t: number; rssMb: number; heapUsedMb: number; loopP99Ms: number; proxyQueue: number }[]
    environment?: EnvironmentRaw | null
    computedAt: number
}

/** One ring sample from the in-memory host metrics sampler (server/lib/host-metrics.js). */
export interface MetricsSampleRaw {
    t: number
    cpuPct: number | null
    memUsedPct: number | null
    rssMb: number
    heapMb: number
    loopP99Ms: number
    reqCount: number
    errCount: number
}

/** Raw shape of GET /api/admin/metrics (server/admin/reads.js reads.metrics). */
export interface MetricsRaw {
    sampledEveryMs: number
    now: {
        t: number
        cpuPct: number | null
        cpuWindowMs: number | null
        /** Null where the platform has no load average (Windows). */
        loadavg: number[] | null
        memUsedBytes: number
        memTotalBytes: number
        memUsedPct: number | null
        rssMb: number
        heapUsedMb: number
        heapTotalMb: number
        loopP50Ms: number
        loopP99Ms: number
        uptimeSec: number
        hostUptimeSec: number
        requestsTotal: number
        errorsTotal: number
    } | null
    series: MetricsSampleRaw[]
    db: { type: string; healthy: boolean | null; mainBytes: number | null; walBytes: number | null; shmBytes: number | null; totalBytes: number | null } | null
    disk: { available: boolean; freeBytes: number | null; totalBytes: number | null; usedPct: number | null } | null
    workers: {
        autopilot: { enabled: boolean; running: boolean; lastCycle: { endedAt: number | null; error: string | null } | null }
        activity: { enabled: boolean; running: boolean; lastCycle: { endedAt: number | null; error: string | null } | null } | null
    }
    limits: { points: number; sampledEveryMs: number; window: string }
    notes: Record<string, string>
    computedAt: number
}

export interface MetricCardView {
    id: string
    label: string
    value: string
    detail: string
    /** Second honest line, e.g. "point-in-time; no history kept". */
    note?: string
    tone?: Tone
    /** 60 minute trend; null on point-in-time cards. */
    spark: { values: number[]; ariaLabel: string } | null
}

export interface MetricsRequestsView {
    totalLabel: string
    errorsLabel: string
    errorTone?: Tone
    reqBars: number[]
    errBars: number[]
    reqAria: string
    errAria: string
    showLogLink: boolean
    note: string
}

export interface MetricsInfo {
    /** False when the sampler has no live read; the screens fall back quietly. */
    available: boolean
    samplingLabel: string
    cards: MetricCardView[]
    requests: MetricsRequestsView | null
    workers: WorkerFreshnessRow[]
    rings: RingSeries[]
    disk: { pctFree: number | null; label: string; unavailable: boolean; tone?: Tone } | null
    computedAt: number
}

export interface UserRowRaw {
    /** Stable, non-reversible label and the only lookup key. */
    handle: string
    firstSeenMonth: string | null
    lastSeenDay: string | null
    inactiveDays: number | null
    /** Whole hours since last seen, only inside 48 h. */
    lastSeenHoursAgo?: number | null
    connections: Record<string, number>
    rules: { total: number; active: number }
    storageBytes: number
    /** Operator account state; absent on caches from before the actions update. */
    status?: 'active' | 'disabled' | 'deleted'
    /** Soft-delete recovery window end; only set while deleted. */
    restoreUntil?: string | null
}

export interface UsersPageRaw {
    rows: UserRowRaw[]
    cursor: string | null
    total: number
    filters: { accounts: number; syncedToday: number; active7d: number; inactive180: number }
    bulkCap: number
    computedAt: number
}

export interface UserDetailRaw extends UserRowRaw {
    repairs: { key: string; tier: 1 | 2; label: string; available: boolean; description?: string }[]
    actionsAvailable: boolean
    computedAt: number
}

export interface AutopilotRaw {
    worker: {
        running: boolean
        intervalMs: number
        lastRunAt: number | null
        lastCycleEndedAt: number | null
        lastCycle: { scanned: number; budgetHit: boolean; durationMs: number } | null
        recheckMs: number | null
        cycleBudgetMs: number | null
        disabledReason: string | null
    }
    rules: { total: number; active: number; automatic: number; byPlatform: Record<string, { total: number; active: number }> }
    failovers24h: Record<string, number>
    tripwire: {
        enabled: boolean
        statementsLastHour: number
        bytesLastHour: number
        limits: { statements: number; bytes: number } | null
        activeRules: number
        safeMode: { since: number; reason: string } | null
    }
    caches: Record<string, { entries?: number } | null> | null
    computedAt: number
}

export interface ActivityEngineRaw {
    enabled: boolean
    running: boolean
    lastCycle: {
        skipped?: boolean
        error?: string
        startedAt?: number
        durationMs?: number
        accountsScanned?: number
        accountsSkippedByHash?: number
        accountsSkippedByBreaker?: number
        eventsWritten?: number
        snapshotWrites?: number
        snapshotDeletes?: number
        budgetExhausted?: boolean
    } | null
    breakerEntries: number
    config: { enabled?: boolean; intervalMs?: number; jitterMs?: number; maxAccountsPerCycle?: number } | null
    scope: string
    computedAt: number
}

export interface TaskItemRaw {
    id: string
    label: string
    intervalMs: number | null
    enabled: boolean
    running: boolean
    lastRunAt: number | null
    idempotent: boolean
    error?: string
}

export interface TasksRaw {
    items: TaskItemRaw[]
    runNowAvailable: boolean
    computedAt: number
}

export interface CacheLayerRaw {
    id: string
    label: string
    error?: string
    /** Metadata layer counters: one layer with l1 and l2 fields. */
    l1_entries?: number
    l1_max_entries?: number
    l1_bytes?: number
    l1_max_bytes?: number
    l1_utilization_pct?: number
    l1_evictions_total?: number
    l2_rows?: number
    l2_expired_pending?: number
    pending_requests?: number
    dedup_hits_total?: number
    l1_hits_total?: number
    l2_hits_total?: number
    misses_total?: number
    stale_served_total?: number
    overall_hit_rate_pct?: number
    db_inserts_total?: number
    db_deletes_total?: number
    db_updates_total?: number
    last_cleanup_deleted?: number
    last_cleanup_at?: number | null
    /** Generic layer counters. */
    entries?: number
    totalBytes?: number
    maxTotalBytes?: number
    hits?: number
    misses?: number
    stores?: number
    evictions?: number
    itemSkips?: number
    invalidations?: number
    [key: string]: unknown
}

export interface CacheRaw {
    layers: CacheLayerRaw[]
    proxyQueue: { length: number; max: number; active: number; concurrency: number; distinctKeys: number; busiestKeyCount: number }
    clearAvailable: boolean
    computedAt: number
}

export type SettingType = 'boolean' | 'select' | 'number' | 'text' | 'longtext' | 'list' | 'secret'
export type SettingSource = 'env' | 'here' | 'default' | 'internal'

export interface SettingRowRaw {
    key: string
    label: string
    type: SettingType
    summary: string
    more: string
    source: SettingSource
    apply: 'live' | 'restart'
    envOnly: boolean
    envOnlyReason?: string
    restartPending: boolean
    stored: boolean
    options?: string[]
    min?: number
    max?: number
    unit?: { label: string; factor: number }
    /** Secrets only: whether a value exists. Secret values are never sent. */
    set?: boolean
    value?: string | null
    default?: string | null
    defaultLabel?: string
    storedValue?: string
    canAdopt?: boolean
    /** Why a stored value was not applied at startup: invalid, decrypt or not-storable. */
    bootSkipped?: string
}

export interface SettingsRaw {
    precedence: SettingSource[]
    groups: { id: string; title: string; note: string | null; rows: SettingRowRaw[] }[]
    readOnly: boolean
    restartPending: number
    /** The stored settings could not be read at startup; restart keys are not applied. */
    bootReadFailed?: boolean
    /** Live keys were applied from the store once the database opened. */
    bootLiveReapplied?: boolean
    computedAt: number
}

export interface SettingsSaveRaw {
    ok: true
    saved?: number
    copied?: number
    restartNeeded?: string[]
    settings: SettingsRaw
}

export interface SettingsExportRaw {
    format: 'aiomanager-settings'
    version: number
    exportedAt: string
    values: Record<string, string>
    secretsLeftOut: string[]
}

export interface SettingsImportRaw {
    ok: true
    applied: number
    changes: { key: string; label: string; from: string | null; to: string | null; apply: 'live' | 'restart' }[]
    rejected: { key: string; label?: string; error: string }[]
    skipped: { key: string; label: string; reason: string }[]
    settings?: SettingsRaw
}

export interface LogLineRaw {
    seq: number
    at: string
    level: 'info' | 'warn' | 'error'
    module: string
    /** Restricted lines carry the fixed marker instead of text. */
    message: string
}

export interface LogsPageRaw {
    lines: LogLineRaw[]
    levels: { all: number; info: number; warn: number; error: number }
    /** Distinct module list of the ring, so the filter needs no extra scan. */
    modules: string[]
    bufferSize: number
    lastSeq: number
    redaction: string
    /** Seq of the oldest returned line, null when there is nothing older. */
    nextCursor: number | null
}

// ---------------------------------------------------------------------------
// View models (what the screens render)
// ---------------------------------------------------------------------------

export interface AdminStatus {
    enabled: boolean
    setupRequired: boolean
    setupAvailable: boolean
    signedIn: boolean
    readOnlyReplica: boolean
    rememberedBrowser: boolean
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info'

export interface KpiEntry {
    id: string
    label: string
    value: string
    detail: string
    tone?: Tone
}

export interface SignalEntry {
    id: string
    tone: Tone
    title: string
    detail: string
    section?: string
}

export interface GuaranteeEntry {
    title: string
    detail: string
}

export interface VerdictView {
    state: 'healthy' | 'watch' | 'down'
    title: string
    detail: string
    watching: number
}

export interface OverviewInfo {
    verdict: VerdictView
    kpis: KpiEntry[]
    /** Raw accounts total for the phone drill-in row badge (null while the users read fails). */
    accountsRaw: number | null
    signals: SignalEntry[]
    recentAudit: { seq: number; at: string; action: string; detail: string; hashPrefix: string }[]
    guarantees: GuaranteeEntry[]
}

export interface RingSeries {
    label: string
    unit: string
    values: number[]
}

export interface SystemInfo {
    kpis: KpiEntry[]
    version: string
    mode: string
    readOnly: boolean
    runtime: string
    database: { type: string; healthy: boolean; sizeLabel: string; freeLabel: string; walLabel: string }
    uptimeLabel: string
    startedLabel: string
    eventLoopLabel: string
    rings: RingSeries[]
    ringNote: string
    /** Environment card rows (DP-13); null rows are omitted, null itself hides both cards. */
    environment: SystemEnvironment | null
}

export type UserFilterId = 'all' | 'active' | 'active-today' | 'active-7d' | 'inactive' | 'inactive-180' | 'with-rules' | 'with-failover'

export interface UserRow {
    handle: string
    createdLabel: string
    lastSeenLabel: string
    inactiveDays: number | null
    connectionCount: number
    connectionsDetail: string
    /** Counts per connection type, largest first. Counts only, never contents. */
    connections: { platform: string; count: number }[]
    storageBytes: number
    ruleCount: number
    rulesActive: number
    storageLabel: string
    status: 'active' | 'disabled' | 'deleted' | null
    /** Days left in the soft-delete recovery window; only while deleted. */
    restoreUntilLabel: string | null
}

export interface UsersPage {
    filters: UserFilters
    rows: UserRow[]
    cursor: string | null
    total: number
    bulkCap: number
}

export interface UserFilters {
    accounts: number
    syncedToday: number
    active7d: number
    inactive180: number
}

export interface RepairSpec {
    id: string
    name: string
    tier: 1 | 2
    available: boolean
    description?: string | null
}

/** One audited repair run for this account, from the hash-chained audit feed. */
export interface RepairHistoryRowRaw {
    seq: number
    at: string
    repair: string | null
    reason: string | null
    counts: Record<string, number> | null
}

export interface RepairsFeedRaw {
    repairs: UserDetailRaw['repairs']
    history: RepairHistoryRowRaw[]
}

/** The dry-run plan: what a repair would touch, and the notice the user would see. */
export interface RepairPreviewRaw {
    scope: string
    matchCount: number
    summary: string
    samples: string[]
    userNotice: string
}

export interface BulkPreviewRaw {
    expected: number
    setHash: string
    cap: number
}

export interface UserDetail {
    handle: string
    createdLabel: string
    lastSeenLabel: string
    inactiveDays: number | null
    connectionsLabel: string
    connectionsDetail: string
    ruleCountLabel: string
    storageLabel: string
    status: 'active' | 'disabled' | 'deleted' | null
    restoreUntilLabel: string | null
    repairs: RepairSpec[]
    actionsAvailable: boolean
}

export interface RepairHistoryRow {
    id: number
    atLabel: string
    repairId: string | null
    repairLabel: string
    reason: string | null
    outcomeLabel: string
}

export interface RepairsFeed {
    repairs: RepairSpec[]
    history: RepairHistoryRow[]
}

export interface RepairPreview {
    scope: string
    matchCount: number
    summary: string
    samples: string[]
    userNotice: string
}

export interface RepairResult {
    ok: true
    counts: Record<string, number>
    message: string
}

export interface AutopilotInfo {
    worker: {
        running: boolean
        intervalLabel: string
        lastRunLabel: string
        lastCycleLabel: string
        lastCycleDetail: string
        recheckLabel: string
        budgetLabel: string
        disabledReason: string | null
    }
    rules: { total: number; active: number; automatic: number }
    rulesByPlatform: { platform: string; count: number; active: number; pct: number }[]
    failovers24h: { type: string; count: number }[]
    tripwire: {
        enabled: boolean
        safeMode: boolean
        safeModeSinceLabel: string | null
        safeModeReason: string | null
        statementsPct: number
        bytesPct: number
        statementsLabel: string
        bytesLabel: string
        note: string
    }
    healthCacheEntries: number | null
}

export interface ActivityEngineInfo {
    enabled: boolean
    running: boolean
    lastScan: { agoLabel: string; durationLabel: string; everyLabel: string }
    accounts: { scanned: number | null; hashSkipped: number | null; breakerSkipped: number | null }
    events: { written: number | null; snapshotDeletes: number | null }
    breaker: { inBackoff: number }
    lastCycleError: string | null
    budgetExhausted: boolean
    scopeNote: string
}

export interface TaskJob {
    id: string
    name: string
    schedule: string
    lastRunLabel: string | null
    enabled: boolean
    running: boolean
    runnable: boolean
    note: string
}

export interface TasksInfo {
    jobs: TaskJob[]
    runNote: string
    runNowAvailable: boolean
}

export interface CacheLayer {
    id: string
    name: string
    /** Short token used in typed confirmations, e.g. "CLEAR METADATA". */
    short: string
    entries: number
    entriesLabel: string
    sizeLabel: string
    hitRatePct: number | null
    tone?: Tone
    clearable: boolean
    rows: { label: string; pct: number | null; value: string; tone?: Tone }[]
    note: string
}

export interface CacheInfo {
    layers: CacheLayer[]
    proxyQueue: { label: string; pct: number; value: string; tone?: Tone }
    clearAvailable: boolean
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogLine {
    seq: number
    at: string
    timeLabel: string
    level: LogLevel
    module: string
    message: string
}

export interface LogsPage {
    lines: LogLine[]
    levels: { all: number; info: number; warn: number; error: number }
    modules: string[]
    bufferSize: number
    lastSeq: number
    redaction: string
    nextCursor: number | null
}

export interface SettingRow {
    key: string
    label: string
    type: SettingType
    summary: string
    more: string
    source: SettingSource
    apply: 'live' | 'restart'
    /** Read-only here: env-only keys, and keys the environment sets. */
    locked: boolean
    envOnly: boolean
    envOnlyReason: string | null
    restartPending: boolean
    options: string[] | null
    min: number | null
    max: number | null
    unit: { label: string; factor: number } | null
    secretSet: boolean | null
    value: string | null
    defaultValue: string | null
    defaultLabel: string | null
    storedValue: string | null
    canAdopt: boolean
    bootSkipped: string | null
}

export interface SettingsGroup {
    id: string
    title: string
    chipLabel: string
    note: string | null
    rows: SettingRow[]
}

export interface SettingsInfo {
    groups: SettingsGroup[]
    readOnly: boolean
    restartPending: number
    bootReadFailed: boolean
    bootLiveReapplied: boolean
}

export interface AuditRow {
    seq: number
    at: string
    timeLabel: string
    event: string
    action: string
    detail: string
    result: string
    actor: string
    device: string | null
    hash: string
    prevHash: string
}

export interface AuditPage {
    rows: AuditRow[]
    cursor: string | null
    retentionNote: string
}

export interface AuditVerify {
    ok: boolean
    rows: number
    verifiedAt: string
    verifiedAtLabel: string
    head: string | null
    brokenAt: number | null
    reason: 'hash' | 'link' | 'gap' | null
}

export interface AdminSessionRow {
    id: string
    uaFamily: string
    createdLabel: string
    lastSeenLabel: string
    expiresLabel: string
    ipPrefix: string
    current: boolean
}

export interface AdminSessionsInfo {
    rows: AdminSessionRow[]
    idleTimeoutLabel: string
    absoluteTimeoutLabel: string
    note: string
}

// ---------------------------------------------------------------------------
// Mappers (raw -> view). Exported so the contract test can pin the fixtures.
// ---------------------------------------------------------------------------

const DB_ENGINE_LABELS: Record<string, string> = { postgres: 'PostgreSQL', sqlite: 'SQLite' }
const CONTAINER_RUNTIME_LABELS: Record<string, string> = { docker: 'Docker', containerd: 'containerd', kubepods: 'Kubernetes', lxc: 'LXC' }
const MONTHS_UTC = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A build date is a fixed instant, so it renders in UTC and never re-labels per viewer. */
function formatBuildDateUtc(iso: string | null): string | null {
    if (!iso) return null
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    const hh = String(d.getUTCHours()).padStart(2, '0')
    const mm = String(d.getUTCMinutes()).padStart(2, '0')
    return `${MONTHS_UTC[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()} ${hh}:${mm} UTC`
}

/** Environment rows for the System cards. The node version stays on the Version and mode Runtime row, never here. */
function mapSystemEnvironment(raw: EnvironmentRaw): SystemEnvironment {
    const cpu = [
        raw.cpuModel,
        typeof raw.cpuCores === 'number' && raw.cpuCores > 0 ? `${formatCount(raw.cpuCores)} core${raw.cpuCores === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(', ') || null
    const container = !raw.container ? null
        : raw.container.detected
            ? [
                'Yes',
                raw.container.runtime
                    ? `${CONTAINER_RUNTIME_LABELS[raw.container.runtime] ?? raw.container.runtime}${raw.container.runtimeVersion ? ` ${raw.container.runtimeVersion}` : ''}`
                    : null,
            ].filter(Boolean).join(', ') || 'Yes'
            : 'No'
    return {
        os: raw.os || null,
        cpu,
        memory: typeof raw.totalMemBytes === 'number' && raw.totalMemBytes > 0 ? `${formatBytes(raw.totalMemBytes)} total` : null,
        timezone: raw.timezone || null,
        container,
        database: raw.db
            ? `${DB_ENGINE_LABELS[raw.db.engine] ?? raw.db.engine}${raw.db.version ? ` ${raw.db.version}` : ''}`
            : null,
        dataDir: raw.dataDir || null,
        build: raw.build
            ? [raw.build.commit, formatBuildDateUtc(raw.build.date)].filter(Boolean).join(', ') || null
            : null,
    }
}

/** Catalog names for audit-history rows, which carry only the repair key. */
const REPAIR_LABELS: Record<string, string> = {
    'release-sync-lease': "Clear this account's sync server caches",
    'clear-server-caches': "Clear this account's server caches",
    'reset-activity-breaker': 'Reset the activity scan breaker',
    'clear-login-backoff': 'Clear login backoff',
    'recheck-failover': 'Re-run the Failover health check',
    'refresh-connection-token': 'Force a connection token refresh',
    'purge-orphaned-state': 'Purge orphaned server state',
}

/** "29 d left" while the soft-delete recovery window is open. */
function restoreWindowLabel(restoreUntil: string | null | undefined): string | null {
    if (!restoreUntil) return null
    const t = Date.parse(restoreUntil)
    if (Number.isNaN(t)) return null
    const days = Math.ceil((t - Date.now()) / 86_400_000)
    return days >= 1 ? `${days} d left` : 'window ending'
}

const humanCountKey = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()

/** Repair outcome from audit counts: "2 cached auth, 1 sync response cache". */
function outcomeLabel(counts: Record<string, number> | null): string {
    const entries = Object.entries(counts ?? {}).filter(([, v]) => Number.isFinite(v))
    if (!entries.length) return 'no counts recorded'
    return entries.map(([k, v]) => `${formatCount(v)} ${humanCountKey(k)}`).join(', ')
}

const mappers = {
    status(raw: AdminStatusRaw): AdminStatus {
        return { ...raw, readOnlyReplica: Boolean(raw.readOnlyReplica), rememberedBrowser: Boolean(raw.rememberedBrowser) }
    },

    overview(raw: OverviewRaw): OverviewInfo {
        const watching = raw.signals.filter(s => s.severity === 'watch').length
        const state: VerdictView['state'] = raw.verdict === 'action' ? 'down' : raw.verdict === 'watch' ? 'watch' : 'healthy'
        const title = raw.verdict === 'action' ? 'Needs action' : raw.verdict === 'watch' ? `Healthy, ${watching} watch` : 'Healthy'
        const detail = `Updated ${relTime(raw.computedAt)}. Refreshes every 30 s while open; nothing is written by watching.`
        const k = raw.kpis
        const na = (n: number | null | undefined, label = 'n/a') => (n === null || n === undefined ? label : formatCount(n))
        const connTotal = k.connections ? Object.values(k.connections).reduce((a, b) => a + b, 0) : null
        const connDetail = k.connections ? Object.entries(k.connections).map(([p, n]) => `${p} ${formatCount(n)}`).join(', ') || 'none' : 'read unavailable'
        const kpis: KpiEntry[] = [
            { id: 'accounts', label: 'Accounts', value: na(k.accounts), detail: k.active30d === null ? 'read unavailable' : `${formatCount(k.active30d)} active in 30 d` },
            { id: 'uptime', label: 'Uptime', value: formatUptime(k.uptimeSec), detail: `version ${k.version}` },
            { id: 'rules', label: 'Autopilot rules', value: na(k.rulesActive), detail: k.failovers24h === null ? 'read unavailable' : `${formatCount(k.failovers24h)} failovers in 24 h`, tone: k.rulesActive === null ? 'warn' : 'ok' },
            { id: 'connections', label: 'Connections', value: na(connTotal), detail: connDetail },
            { id: 'active7', label: 'Active in 7 d', value: na(k.active7d), detail: 'accounts seen this week' },
        ]
        const sectionByPrefix: [string, string][] = [
            ['db-', 'system'], ['event-loop', 'system'], ['system-unavailable', 'system'], ['autopilot', 'autopilot'], ['tripwire', 'autopilot'],
            ['proxy-queue', 'cache'], ['dashboard-', 'sessions'], ['activity-', 'activity-engine'], ['users-unavailable', 'users'],
        ]
        const signals: SignalEntry[] = raw.signals.map(s => {
            const tone: Tone = s.severity === 'action' ? 'bad' : s.severity === 'watch' ? 'warn' : 'info'
            const match = sectionByPrefix.find(([prefix]) => s.key.startsWith(prefix))
            let section = match?.[1]
            if (!section && s.key.includes('cache')) section = 'cache'
            // Every warning carries a next step; info rows link only where a real target exists.
            if (!section && s.severity !== 'info') section = 'logs'
            return { id: s.key, tone, title: s.text, detail: '', section }
        })
        const guarantees: GuaranteeEntry[] = raw.guarantees.map(g => {
            const idx = g.indexOf('. ')
            return idx > 0 && idx < 80
                ? { title: g.slice(0, idx + 1), detail: g.slice(idx + 2) }
                : { title: g, detail: '' }
        })
        return {
            verdict: { state, title, detail, watching },
            kpis,
            accountsRaw: k.accounts,
            signals,
            recentAudit: raw.recentAudit.map(a => ({ seq: a.seq, at: relTime(a.at), action: a.action || a.event, detail: a.detail, hashPrefix: a.hashPrefix })),
            guarantees,
        }
    },

    system(raw: SystemRaw): SystemInfo {
        const history = raw.history
        const latest = history[history.length - 1]
        const kpis: KpiEntry[] = [
            { id: 'rss', label: 'Memory (RSS)', value: latest ? `${latest.rssMb} MB` : 'unknown', detail: latest ? `heap ${latest.heapUsedMb} MB, same sample` : 'no sample yet' },
            { id: 'heap', label: 'Heap used', value: latest ? `${latest.heapUsedMb} MB` : 'unknown', detail: `${raw.memory.heapTotalMb} MB total` },
            { id: 'loop', label: 'Event loop p99', value: raw.eventLoop ? `${raw.eventLoop.p99Ms} ms` : 'unknown', detail: raw.eventLoop ? `p50 ${raw.eventLoop.p50Ms} ms, max ${raw.eventLoop.maxMs} ms` : 'not sampled yet', tone: raw.eventLoop && raw.eventLoop.p99Ms >= 200 ? 'warn' : 'ok' },
            { id: 'queue', label: 'Proxy queue', value: latest ? formatCount(latest.proxyQueue) : 'unknown', detail: 'outbound requests waiting' },
        ]
        const rings: RingSeries[] = [
            { label: 'Memory RSS, MB', unit: 'MB', values: history.map(h => h.rssMb) },
            { label: 'Heap used, MB', unit: 'MB', values: history.map(h => h.heapUsedMb) },
            { label: 'Event loop p99, ms', unit: 'ms', values: history.map(h => h.loopP99Ms) },
            { label: 'Proxy queue depth', unit: '', values: history.map(h => h.proxyQueue) },
        ]
        return {
            kpis,
            version: raw.version,
            mode: raw.readOnly ? `${raw.mode} (read-only)` : raw.mode,
            readOnly: raw.readOnly,
            runtime: `${raw.node}, ${raw.platform}`,
            database: {
                type: raw.database.type,
                healthy: raw.database.healthy,
                sizeLabel: formatBytes(raw.database.sizeBytes),
                freeLabel: formatBytes(raw.database.freeBytes),
                walLabel: formatBytes(raw.database.walBytes),
            },
            uptimeLabel: formatUptime(raw.uptimeSec),
            startedLabel: formatDateTime(raw.startedAt),
            eventLoopLabel: raw.eventLoop ? `p50 ${raw.eventLoop.p50Ms} ms, p99 ${raw.eventLoop.p99Ms} ms` : 'not sampled yet',
            rings,
            ringNote: `Sampled in memory once a minute, ${history.length} point${history.length === 1 ? '' : 's'} per chart, cached 30 s.`,
            environment: raw.environment ? mapSystemEnvironment(raw.environment) : null,
        }
    },

    // Host metrics (DP-02): values are always present when the read succeeds;
    // every unavailable case degrades to an honest label instead of a guess.
    metrics(raw: MetricsRaw): MetricsInfo {
        const now = raw.now
        if (!now) {
            return { available: false, samplingLabel: '', cards: [], requests: null, workers: [], rings: [], disk: null, computedAt: raw.computedAt }
        }
        const series = raw.series
        const cadence = raw.sampledEveryMs
        const windowText = samplingWindowLabel(series.length, cadence)
        // Unmeasured points (the first CPU window) are dropped, never charted as zero.
        const col = (key: 'cpuPct' | 'memUsedPct' | 'rssMb' | 'loopP99Ms'): number[] => series.flatMap(s => {
            const v = s[key]
            return typeof v === 'number' && Number.isFinite(v) ? [v] : []
        })
        const pct = (n: number | null): string => (n === null ? 'n/a' : `${n}%`)
        const cards: MetricCardView[] = [
            {
                id: 'cpu',
                label: 'Host CPU',
                value: pct(now.cpuPct),
                detail: now.cpuPct === null
                    ? 'ready after the next sample'
                    : Array.isArray(now.loadavg) && now.loadavg.some(n => n > 0)
                        ? `${now.loadavg.join(', ')} (1/5/15 min)`
                        : 'load average needs a non-Windows host',
                tone: thresholdTone(now.cpuPct, 70, 90),
                spark: { values: col('cpuPct'), ariaLabel: sparkAria('Host CPU', col('cpuPct'), '%', windowText) },
            },
            {
                id: 'memory',
                label: 'Host memory',
                value: pct(now.memUsedPct),
                detail: `${formatBytes(now.memUsedBytes)} of ${formatBytes(now.memTotalBytes)} used`,
                tone: thresholdTone(now.memUsedPct, 90, 97),
                spark: { values: col('memUsedPct'), ariaLabel: sparkAria('Host memory', col('memUsedPct'), '%', windowText) },
            },
            {
                id: 'rss',
                label: 'Process RSS',
                value: `${now.rssMb} MB`,
                detail: `heap ${now.heapUsedMb} of ${now.heapTotalMb} MB`,
                spark: { values: col('rssMb'), ariaLabel: sparkAria('Process RSS', col('rssMb'), 'MB', windowText) },
            },
            {
                id: 'loop',
                label: 'Event loop p99',
                value: `${now.loopP99Ms} ms`,
                detail: `p50 ${now.loopP50Ms} ms; warn over 200 ms`,
                tone: thresholdTone(now.loopP99Ms, 200, 1000),
                spark: { values: col('loopP99Ms'), ariaLabel: sparkAria('Event loop p99', col('loopP99Ms'), 'ms', windowText) },
            },
        ]
        const diskRaw = raw.disk
        const freeBytes = diskRaw?.available === true ? diskRaw.freeBytes : null
        const totalBytes = diskRaw?.available === true ? diskRaw.totalBytes : null
        const diskOk = freeBytes !== null && totalBytes !== null
        const freePct = freeBytes !== null && totalBytes !== null ? Math.round((freeBytes / totalBytes) * 100) : null
        cards.push({
            id: 'disk',
            label: 'Disk free',
            value: diskOk ? formatBytes(freeBytes) : 'unavailable',
            detail: diskOk ? `of ${formatBytes(totalBytes)} (${freePct}% free)` : 'not exposed by this platform or build',
            note: 'point-in-time; no history kept',
            tone: freeShareTone(freePct, 10, 5),
            spark: null,
        })
        const db = raw.db
        cards.push({
            id: 'db',
            label: 'Database size',
            value: db && db.totalBytes !== null ? formatBytes(db.totalBytes) : 'unknown',
            detail: db ? `${db.type}${db.walBytes !== null ? `, WAL ${formatBytes(db.walBytes)}` : ''}` : 'database read unavailable',
            note: 'point-in-time; one cached read per open',
            spark: null,
        })
        const reqTotal = series.reduce((a, s) => a + s.reqCount, 0)
        const errTotal = series.reduce((a, s) => a + s.errCount, 0)
        const rate = errorRatePct(reqTotal, errTotal)
        const requests: MetricsRequestsView = {
            totalLabel: `${formatCount(reqTotal)} in ${windowText.replace('last ', '')}`,
            errorsLabel: rate === null ? formatCount(errTotal) : `${formatCount(errTotal)} (${rate}%)`,
            errorTone: thresholdTone(rate, 2, 5),
            reqBars: series.map(s => s.reqCount),
            errBars: series.map(s => s.errCount),
            reqAria: `Requests per minute, ${windowText}: total ${formatCount(reqTotal)}, latest ${formatCount(series[series.length - 1]?.reqCount ?? 0)}`,
            errAria: `Errors per minute, ${windowText}: total ${formatCount(errTotal)}, latest ${formatCount(series[series.length - 1]?.errCount ?? 0)}`,
            showLogLink: errTotal > 0,
            note: 'Only requests the server answered are counted; the log tail stays redacted.',
        }
        return {
            available: true,
            samplingLabel: samplingLabel(cadence, series.length),
            cards,
            requests,
            workers: workerFreshnessRows(raw.workers.autopilot, raw.workers.activity, Date.now()),
            rings: [
                { label: 'Host CPU, %', unit: '%', values: col('cpuPct') },
                { label: 'Host memory, %', unit: '%', values: col('memUsedPct') },
                { label: 'Process RSS, MB', unit: 'MB', values: col('rssMb') },
                { label: 'Event loop p99, ms', unit: 'ms', values: col('loopP99Ms') },
            ],
            disk: {
                pctFree: freePct,
                label: diskOk ? `${formatBytes(freeBytes)} of ${formatBytes(totalBytes)} free` : 'not exposed by this platform or build',
                unavailable: !diskOk,
                tone: freeShareTone(freePct, 10, 5),
            },
            computedAt: raw.computedAt,
        }
    },

    userRow(raw: UserRowRaw): UserRow {
        const connections = Object.entries(raw.connections)
        return {
            handle: raw.handle,
            createdLabel: formatMonth(raw.firstSeenMonth),
            lastSeenLabel: typeof raw.lastSeenHoursAgo === 'number'
                ? raw.lastSeenHoursAgo < 1 ? 'under 1 h ago' : `${raw.lastSeenHoursAgo} h ago`
                : formatDay(raw.lastSeenDay),
            inactiveDays: raw.inactiveDays,
            connectionCount: connections.reduce((a, [, n]) => a + n, 0),
            connectionsDetail: connections.map(([p, n]) => `${p} ${n}`).join(', '),
            connections: connections.filter(([, n]) => n > 0).map(([platform, count]) => ({ platform, count })).sort((a, b) => b.count - a.count),
            storageBytes: raw.storageBytes,
            ruleCount: raw.rules.total,
            rulesActive: raw.rules.active,
            storageLabel: formatBytes(raw.storageBytes),
            status: raw.status ?? null,
            restoreUntilLabel: restoreWindowLabel(raw.restoreUntil ?? null),
        }
    },

    usersPage(raw: UsersPageRaw): UsersPage {
        return {
            filters: raw.filters,
            rows: raw.rows.map(mappers.userRow),
            cursor: raw.cursor,
            total: raw.total,
            bulkCap: raw.bulkCap,
        }
    },

    userDetail(raw: UserDetailRaw): UserDetail {
        const base = mappers.userRow(raw)
        return {
            handle: raw.handle,
            createdLabel: base.createdLabel,
            lastSeenLabel: raw.lastSeenDay
                ? `${formatDay(raw.lastSeenDay)}${raw.inactiveDays !== null ? `, inactive ${formatCount(raw.inactiveDays)} d` : ''}`
                : 'never seen',
            inactiveDays: raw.inactiveDays,
            connectionsLabel: `${base.connectionCount} connection${base.connectionCount === 1 ? '' : 's'}`,
            connectionsDetail: base.connectionsDetail,
            ruleCountLabel: `${formatCount(raw.rules.total)}, ${formatCount(raw.rules.active)} active`,
            storageLabel: base.storageLabel,
            status: raw.status ?? null,
            restoreUntilLabel: base.restoreUntilLabel,
            repairs: raw.repairs.map(r => ({ id: r.key, name: r.label, tier: r.tier, available: r.available, description: r.description ?? null })),
            actionsAvailable: raw.actionsAvailable,
        }
    },

    repairsFeed(raw: RepairsFeedRaw): RepairsFeed {
        return {
            repairs: raw.repairs.map(r => ({ id: r.key, name: r.label, tier: r.tier, available: r.available, description: r.description ?? null })),
            history: raw.history.map(h => ({
                id: h.seq,
                atLabel: relTime(h.at),
                repairId: h.repair,
                repairLabel: h.repair ? REPAIR_LABELS[h.repair] ?? h.repair : 'a repair',
                reason: h.reason,
                outcomeLabel: outcomeLabel(h.counts),
            })),
        }
    },

    repairPreview(raw: RepairPreviewRaw): RepairPreview {
        return { scope: raw.scope, matchCount: raw.matchCount, summary: raw.summary, samples: raw.samples.slice(0, 3), userNotice: raw.userNotice }
    },

    autopilot(raw: AutopilotRaw): AutopilotInfo {
        const total = raw.rules.total || 1
        const limits = raw.tripwire.limits
        const stmtPct = limits?.statements ? Math.min(100, Math.round((raw.tripwire.statementsLastHour / limits.statements) * 100)) : 0
        const bytesPct = limits?.bytes ? Math.min(100, Math.round((raw.tripwire.bytesLastHour / limits.bytes) * 100)) : 0
        return {
            worker: {
                running: raw.worker.running,
                intervalLabel: formatIntervalMs(raw.worker.intervalMs),
                lastRunLabel: relTime(raw.worker.lastRunAt),
                lastCycleLabel: raw.worker.lastCycleEndedAt ? relTime(raw.worker.lastCycleEndedAt) : 'never',
                lastCycleDetail: raw.worker.lastCycle
                    ? `${formatCount(raw.worker.lastCycle.scanned)} rules in ${formatDurationMs(raw.worker.lastCycle.durationMs)}${raw.worker.lastCycle.budgetHit ? ', budget hit' : ', no budget hit'}`
                    : 'no cycle recorded yet',
                budgetLabel: raw.worker.cycleBudgetMs ? `cycle budget ${formatDurationMs(raw.worker.cycleBudgetMs)}` : '',
                recheckLabel: formatIntervalMs(raw.worker.recheckMs),
                disabledReason: raw.worker.disabledReason,
            },
            rules: raw.rules,
            rulesByPlatform: Object.entries(raw.rules.byPlatform).map(([platform, v]) => ({
                platform,
                count: v.total,
                active: v.active,
                pct: Math.round((v.total / total) * 100),
            })).sort((a, b) => b.count - a.count),
            failovers24h: Object.entries(raw.failovers24h).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
            tripwire: {
                enabled: raw.tripwire.enabled,
                safeMode: Boolean(raw.tripwire.safeMode),
                safeModeSinceLabel: raw.tripwire.safeMode ? relTime(raw.tripwire.safeMode.since) : null,
                safeModeReason: raw.tripwire.safeMode?.reason ?? null,
                statementsPct: stmtPct,
                bytesPct,
                statementsLabel: limits ? `${formatCount(raw.tripwire.statementsLastHour)} of ${formatCount(limits.statements)} statements` : 'no limit set',
                bytesLabel: limits ? `${formatBytes(raw.tripwire.bytesLastHour)} of ${formatBytes(limits.bytes)}` : 'no limit set',
                note: 'Counts every engine-driven write over a rolling hour, in memory only. Above the budget Autopilot enters safe mode: no DB writes, no pushes, no swaps, no webhooks, until restart.',
            },
            healthCacheEntries: raw.caches?.health?.entries ?? null,
        }
    },

    activityEngine(raw: ActivityEngineRaw): ActivityEngineInfo {
        const lc = raw.lastCycle
        return {
            enabled: raw.enabled,
            running: raw.running,
            lastScan: {
                agoLabel: lc?.startedAt ? relTime(lc.startedAt) : 'never',
                durationLabel: lc?.durationMs !== undefined && lc?.durationMs !== null ? formatDurationMs(lc.durationMs) : 'unknown',
                everyLabel: formatIntervalMs(raw.config?.intervalMs ?? null),
            },
            accounts: {
                scanned: lc ? lc.accountsScanned ?? null : null,
                hashSkipped: lc ? lc.accountsSkippedByHash ?? null : null,
                breakerSkipped: lc ? lc.accountsSkippedByBreaker ?? null : null,
            },
            events: {
                written: lc ? lc.eventsWritten ?? null : null,
                snapshotDeletes: lc ? lc.snapshotDeletes ?? null : null,
            },
            breaker: { inBackoff: raw.breakerEntries },
            lastCycleError: lc?.error ?? null,
            budgetExhausted: Boolean(lc?.budgetExhausted),
            scopeNote: raw.scope,
        }
    },

    tasks(raw: TasksRaw): TasksInfo {
        const jobs: TaskJob[] = raw.items.map(t => ({
            id: t.id,
            name: t.label,
            schedule: formatIntervalMs(t.intervalMs),
            lastRunLabel: t.lastRunAt ? relTime(t.lastRunAt) : null,
            enabled: t.enabled,
            running: t.running,
            runnable: Boolean(raw.runNowAvailable) && t.idempotent && t.enabled && !t.running,
            note: t.error ?? (t.running ? 'running now' : t.idempotent ? 'Idempotent: safe to re-run.' : 'Keeps its own interval and lock, so it has no run-now.'),
        }))
        return {
            jobs,
            runNote: 'Run-now only for idempotent jobs, behind a typed confirmation that lands in the audit log.',
            runNowAvailable: raw.runNowAvailable,
        }
    },

    cache(raw: CacheRaw): CacheInfo {
        const layers: CacheLayer[] = raw.layers.map(layer => {
            const isMetadata = layer.id === 'metadata'
            const entries = isMetadata
                ? (layer.l1_entries ?? 0) + (layer.l2_rows ?? 0)
                : layer.entries ?? 0
            const sizeBytes = isMetadata ? layer.l1_bytes ?? null : layer.totalBytes ?? null
            const hitRate = isMetadata
                ? typeof layer.overall_hit_rate_pct === 'number' ? layer.overall_hit_rate_pct : null
                : layer.hits !== undefined && layer.hits !== null && (layer.hits + (layer.misses ?? 0)) > 0
                    ? Math.round((layer.hits / (layer.hits + (layer.misses ?? 0))) * 100)
                    : null
            const rows: CacheLayer['rows'] = []
            if (isMetadata) {
                rows.push(
                    { label: 'L1 entries', pct: layer.l1_max_entries ? Math.round(((layer.l1_entries ?? 0) / layer.l1_max_entries) * 100) : null, value: `${formatCount(layer.l1_entries ?? 0)} of ${formatCount(layer.l1_max_entries ?? 0)}, ${formatBytes(layer.l1_bytes ?? 0)}` },
                    { label: 'L1 utilization', pct: layer.l1_utilization_pct ?? null, value: `${layer.l1_utilization_pct ?? 0}%, ${formatCount(layer.l1_evictions_total ?? 0)} evictions` },
                    { label: 'L2 rows', pct: null, value: `${formatCount(layer.l2_rows ?? 0)} rows, ${formatCount(layer.l2_expired_pending ?? 0)} expired pending` },
                    { label: 'Overall hit rate', pct: layer.overall_hit_rate_pct ?? null, value: `${layer.overall_hit_rate_pct ?? 0}%`, tone: (typeof layer.overall_hit_rate_pct === 'number' && layer.overall_hit_rate_pct < 85) ? 'warn' : 'ok' },
                    { label: 'Stale served', pct: null, value: `${formatCount(layer.stale_served_total ?? 0)} responses past expiry`, tone: (layer.stale_served_total ?? 0) > 0 ? 'warn' : 'ok' },
                    { label: 'Dedup in flight', pct: null, value: `${formatCount(layer.pending_requests ?? 0)} single-flight merges` },
                )
            } else {
                if (layer.totalBytes !== undefined || layer.maxTotalBytes !== undefined) {
                    rows.push({ label: 'Size', pct: layer.maxTotalBytes ? Math.round(((layer.totalBytes ?? 0) / layer.maxTotalBytes) * 100) : null, value: `${formatBytes(layer.totalBytes ?? 0)} of ${formatBytes(layer.maxTotalBytes ?? 0)}` })
                }
                if (layer.hits !== undefined || layer.misses !== undefined) {
                    const total = (layer.hits ?? 0) + (layer.misses ?? 0)
                    rows.push({ label: 'Hit rate', pct: total ? Math.round(((layer.hits ?? 0) / total) * 100) : 0, value: total ? `${Math.round(((layer.hits ?? 0) / total) * 100)}%, ${formatCount(layer.hits ?? 0)} hits` : 'no lookups yet' })
                }
                if (layer.evictions !== undefined || layer.invalidations !== undefined) {
                    rows.push({ label: 'Evictions and invalidations', pct: null, value: `${formatCount(layer.evictions ?? 0)} evictions, ${formatCount(layer.invalidations ?? 0)} invalidations` })
                }
                if (layer.stores !== undefined) rows.push({ label: 'Stores', pct: null, value: formatCount(layer.stores ?? 0) })
                if (!rows.length && layer.entries !== undefined) rows.push({ label: 'Entries', pct: null, value: formatCount(layer.entries) })
            }
            if (layer.error) rows.push({ label: 'Status', pct: null, value: `stats unavailable: ${layer.error}`, tone: 'warn' })
            return {
                id: layer.id,
                name: layer.label,
                short: layer.id.toUpperCase().replace(/-/g, ' '),
                entries,
                entriesLabel: formatCount(entries),
                sizeLabel: formatBytes(sizeBytes),
                hitRatePct: hitRate,
                tone: hitRate !== null && hitRate < 85 ? 'warn' : undefined,
                clearable: raw.clearAvailable,
                rows,
                note: isMetadata ? 'One cache with a memory layer (L1) and a database layer (L2).' : 'Per-layer counters, read only.',
            }
        })
        const q = raw.proxyQueue
        return {
            layers,
            proxyQueue: {
                label: 'Proxy queue',
                pct: q.max ? Math.round((q.length / q.max) * 100) : 0,
                value: `${formatCount(q.length)} of ${formatCount(q.max)} slots, ${formatCount(q.active)} active of ${formatCount(q.concurrency)}`,
                tone: q.max && q.length / q.max >= 0.8 ? 'warn' : undefined,
            },
            clearAvailable: raw.clearAvailable,
        }
    },

    settingRow(row: SettingRowRaw): SettingRow {
        return {
            key: row.key,
            label: row.label,
            type: row.type,
            summary: row.summary,
            more: row.more,
            source: row.source,
            apply: row.apply,
            locked: row.envOnly || row.source === 'env' || row.source === 'internal',
            envOnly: row.envOnly,
            envOnlyReason: row.envOnlyReason ?? null,
            restartPending: row.restartPending,
            options: row.options ?? null,
            min: row.min ?? null,
            max: row.max ?? null,
            unit: row.type === 'number' ? pickSettingUnit(row.unit ?? null, row.value ?? null) : row.unit ?? null,
            secretSet: row.type === 'secret' ? Boolean(row.set) : null,
            value: row.type === 'secret' ? null : row.value ?? null,
            defaultValue: row.default ?? null,
            defaultLabel: row.defaultLabel ?? null,
            storedValue: row.storedValue ?? null,
            canAdopt: Boolean(row.canAdopt),
            bootSkipped: row.bootSkipped ?? null,
        }
    },

    settings(raw: SettingsRaw): SettingsInfo {
        return {
            groups: raw.groups.map(g => ({
                id: g.id,
                title: g.title,
                chipLabel: g.title.replace(/\s*\(opt-in\)$/i, ''),
                note: g.note,
                rows: g.rows.map(mappers.settingRow),
            })),
            readOnly: raw.readOnly,
            restartPending: raw.restartPending,
            bootReadFailed: Boolean(raw.bootReadFailed),
            bootLiveReapplied: Boolean(raw.bootLiveReapplied),
        }
    },

    auditRow(raw: AuditRowRaw): AuditRow {
        return {
            seq: raw.seq,
            at: raw.at,
            timeLabel: formatDateTime(raw.at),
            event: raw.event,
            action: raw.action || raw.event,
            detail: raw.detail ?? '',
            result: raw.result,
            actor: raw.actor,
            device: raw.device ?? null,
            hash: raw.hash,
            prevHash: raw.prevHash,
        }
    },

    auditPage(raw: AuditPageRaw): AuditPage {
        return {
            rows: raw.rows.map(mappers.auditRow),
            cursor: raw.cursor,
            retentionNote: raw.retentionNote,
        }
    },

    auditVerify(raw: AuditVerifyRaw): AuditVerify {
        return {
            ok: raw.ok,
            rows: raw.rows,
            verifiedAt: raw.verifiedAt,
            verifiedAtLabel: formatDateTime(raw.verifiedAt),
            head: raw.head ?? null,
            brokenAt: raw.brokenAt ?? null,
            reason: raw.reason ?? null,
        }
    },

    sessions(raw: AdminSessionsRaw): AdminSessionsInfo {
        return {
            rows: raw.items.map(s => ({
                id: s.id,
                uaFamily: s.uaFamily ?? 'unknown browser',
                createdLabel: formatDateTime(s.createdAt),
                lastSeenLabel: relTime(s.lastSeenAt),
                expiresLabel: relTime(s.expiresAt),
                ipPrefix: s.ipPrefix ?? '',
                current: s.current,
            })),
            idleTimeoutLabel: 'Idle timeout 30 min',
            absoluteTimeoutLabel: 'absolute max 8 h',
            note: 'Opaque ids, stored hashed server-side, so any session can be revoked. The cookie is HttpOnly and SameSite Strict.',
        }
    },

    logsPage(raw: LogsPageRaw): LogsPage {
        return {
            lines: raw.lines.map(l => ({ ...l, timeLabel: formatClock(l.at) })),
            levels: raw.levels,
            modules: raw.modules ?? [],
            bufferSize: raw.bufferSize,
            lastSeq: raw.lastSeq,
            redaction: raw.redaction,
            nextCursor: raw.nextCursor ?? null,
        }
    },

    logLine(raw: LogLineRaw): LogLine {
        return { ...raw, timeLabel: formatClock(raw.at) }
    },
}

export const mapAdmin = mappers

// ---------------------------------------------------------------------------
// Client functions
// ---------------------------------------------------------------------------


async function readBody(res: { status: number; body: string }): Promise<unknown> {
    if (!res.body) return null
    try {
        return JSON.parse(res.body) as unknown
    } catch {
        return null
    }
}

function errorMessage(payload: unknown, status: number): string {
    if (payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string') {
        return (payload as { error: string }).error
    }
    return status === 401 ? 'Invalid credentials' : `Request failed (${status})`
}

async function getCsrf(force = false): Promise<string | null> {
    const cached = getAdminCsrf()
    if (!force && cached) return cached
    const res = await currentTransport().fetch(`${ADMIN_API_BASE}/session`, { method: 'GET' })
    if (res.status !== 200) return null
    const payload = await readBody(res) as SessionIssuedRaw | null
    setAdminCsrf(payload?.csrf ?? null)
    return getAdminCsrf()
}

export interface UserActionBody {
    reason: string
    /** The typed word the dialog showed, e.g. DISABLE. */
    confirm: string
}

export interface ConfirmBody {
    confirm: string
}

async function adminRequest<T>(
    path: string,
    options: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; signedIn?: boolean; skipCsrf?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
    const method = options.method ?? 'GET'
    const doFetch = currentTransport().fetch
    const needsCsrf = method !== 'GET' && !options.skipCsrf
    const buildInit = async (csrf: string | null): Promise<RequestInit> => {
        const headers: Record<string, string> = {}
        // A bodiless DELETE may omit the content type.
        if (options.body !== undefined) headers['Content-Type'] = 'application/json'
        if (needsCsrf && csrf) headers['X-Admin-CSRF'] = csrf
        return { method, headers, signal: options.signal, body: options.body !== undefined ? JSON.stringify(options.body) : undefined }
    }

    let init = await buildInit(needsCsrf ? await getCsrf() : null)
    let res = await doFetch(path, init)
    // A stale token after server restart or sign-in: refresh once and retry.
    if (res.status === 403 && needsCsrf) {
        invalidateAdminCsrf()
        init = await buildInit(await getCsrf(true))
        res = await doFetch(path, init)
    }
    const payload = await readBody(res)
    if (res.status === 401 && options.signedIn) {
        invalidateAdminCsrf()
        throw new AdminApiError(401, 'Session expired')
    }
    if (res.status < 200 || res.status >= 300) {
        const error = new AdminApiError(res.status, errorMessage(payload, res.status))
        const fieldErrors = payload && typeof payload === 'object' ? (payload as { errors?: unknown }).errors : null
        if (fieldErrors && typeof fieldErrors === 'object') error.fieldErrors = fieldErrors as Record<string, string>
        if (res.status === 409 && payload && typeof payload === 'object' && 'expected' in payload) {
            error.expected = Number((payload as { expected: unknown }).expected)
        }
        // 429 carries Retry-After (locked sign-in, or another sign-in is hashing).
        const retry = 'headers' in res ? (res.headers as Record<string, string> | undefined)?.['retry-after'] : undefined
        if (res.status === 429 && retry) {
            const sec = Number(retry)
            if (Number.isFinite(sec)) error.retryAfterSec = sec
        }
        throw error
    }
    return payload as T
}

export function getAdminStatus(): Promise<AdminStatus> {
    return adminRequest<AdminStatusRaw>(`${ADMIN_API_BASE}/status`).then(mappers.status)
}

export function adminSetup(body: { setupToken: string; username: string; password: string; confirmPassword: string; remember?: boolean }): Promise<SessionIssuedRaw> {
    setAdminCsrf(null)
    return adminRequest<SessionIssuedRaw>(`${ADMIN_API_BASE}/setup`, { method: 'POST', body, skipCsrf: true })
        .then(result => {
            setAdminCsrf(result.csrf)
            return result
        })
}

export function adminLogin(body: { username: string; password: string; remember?: boolean }): Promise<SessionIssuedRaw> {
    setAdminCsrf(null)
    return adminRequest<SessionIssuedRaw>(`${ADMIN_API_BASE}/login`, { method: 'POST', body, skipCsrf: true })
        .then(result => {
            setAdminCsrf(result.csrf)
            return result
        })
}

export function adminLogout(): Promise<{ ok: true }> {
    return adminRequest<{ ok: true }>(`${ADMIN_API_BASE}/logout`, { method: 'POST', body: {}, signedIn: true }).finally(() => {
        setAdminCsrf(null)
    })
}

export function getAdminSession(): Promise<SessionIssuedRaw> {
    return adminRequest<SessionIssuedRaw>(`${ADMIN_API_BASE}/session`, { signedIn: true })
}

export function getOverview(): Promise<OverviewInfo> {
    return adminRequest<OverviewRaw>(`${ADMIN_API_BASE}/overview`, { signedIn: true }).then(mappers.overview)
}

export function getSystem(): Promise<SystemInfo> {
    return adminRequest<SystemRaw>(`${ADMIN_API_BASE}/system`, { signedIn: true }).then(mappers.system)
}

export function getMetrics(): Promise<MetricsInfo> {
    return adminRequest<MetricsRaw>(`${ADMIN_API_BASE}/metrics`, { signedIn: true }).then(mappers.metrics)
}

export interface UsersQuery {
    /** Handle prefix; the server matches acct- hex prefixes only. */
    q?: string
    sort?: 'created' | 'lastseen'
    order?: 'asc' | 'desc'
}

export function getUsers(filter?: UserFilterId, cursor?: string, query: UsersQuery = {}): Promise<UsersPage> {
    const params = new URLSearchParams()
    if (filter && filter !== 'all') params.set('filter', filter)
    if (cursor) params.set('cursor', cursor)
    if (query.q) params.set('q', query.q)
    if (query.sort) params.set('sort', query.sort)
    if (query.order) params.set('order', query.order)
    const qs = params.toString()
    return adminRequest<UsersPageRaw>(`${ADMIN_API_BASE}/users${qs ? `?${qs}` : ''}`, { signedIn: true }).then(mappers.usersPage)
}

export function getUserDetail(handle: string): Promise<UserDetail> {
    return adminRequest<UserDetailRaw>(`${ADMIN_API_BASE}/users/${encodeURIComponent(handle)}`, { signedIn: true }).then(mappers.userDetail)
}

function userAction(handle: string, action: 'disable' | 'enable' | 'delete' | 'restore' | 'signout-devices', body: UserActionBody): Promise<{ ok: true }> {
    return adminRequest<{ ok: true }>(`${ADMIN_API_BASE}/users/${encodeURIComponent(handle)}/${action}`, { method: 'POST', body, signedIn: true })
}

export const disableUser = (handle: string, reason: string, confirm: string) => userAction(handle, 'disable', { reason, confirm })
export const enableUser = (handle: string, reason: string, confirm: string) => userAction(handle, 'enable', { reason, confirm })
export const softDeleteUser = (handle: string, reason: string, confirm: string) => userAction(handle, 'delete', { reason, confirm })
export const restoreUser = (handle: string, reason: string, confirm: string) => userAction(handle, 'restore', { reason, confirm })

/** Revoke every active device session for the account; typed word is SIGNOUT. */
export async function signoutDevicesUser(handle: string, reason: string, confirm: string): Promise<{ ok: true; devices: number; credentialEpoch: number }> {
    return userAction(handle, 'signout-devices', { reason, confirm }) as Promise<{ ok: true; devices: number; credentialEpoch: number }>
}

/**
 * Bulk delete. The server re-checks the inactive set at request time: a 409
 * carrying `expected` means the set changed (or is empty) and the caller must
 * refetch /users and ask again with the new count.
 */
export function bulkDeleteUsers(body: UserActionBody): Promise<{ ok: true; deleted: number; remaining: number; cap: number }> {
    return adminRequest<{ ok: true; deleted: number; remaining: number; cap: number }>(`${ADMIN_API_BASE}/users/bulk-delete`, { method: 'POST', body, signedIn: true })
}

/** The server's count re-check source: what bulk delete would touch right now. */
export function bulkDeletePreview(): Promise<BulkPreviewRaw> {
    return adminRequest<BulkPreviewRaw>(`${ADMIN_API_BASE}/users/bulk-delete/preview`, { signedIn: true })
}

/** Catalog with live availability plus the audited run history for one account. */
export function getRepairsCatalog(handle: string): Promise<RepairsFeed> {
    return adminRequest<RepairsFeedRaw>(`${ADMIN_API_BASE}/users/${encodeURIComponent(handle)}/repairs`, { signedIn: true }).then(mappers.repairsFeed)
}

/** Dry run: the plan (scope, counts, samples) and the user notice; changes nothing. */
export function previewRepair(handle: string, repair: string, reason: string): Promise<RepairPreview> {
    return adminRequest<RepairPreviewRaw>(`${ADMIN_API_BASE}/users/${encodeURIComponent(handle)}/repairs/${encodeURIComponent(repair)}`, {
        method: 'POST',
        body: { reason, dryRun: true },
        signedIn: true,
    }).then(mappers.repairPreview)
}

export function runRepair(handle: string, repair: string, body: { reason: string }): Promise<RepairResult> {
    return adminRequest<RepairResult>(`${ADMIN_API_BASE}/users/${encodeURIComponent(handle)}/repairs/${encodeURIComponent(repair)}`, { method: 'POST', body, signedIn: true })
}

export function getAutopilot(): Promise<AutopilotInfo> {
    return adminRequest<AutopilotRaw>(`${ADMIN_API_BASE}/autopilot`, { signedIn: true }).then(mappers.autopilot)
}

export function getActivityEngine(): Promise<ActivityEngineInfo> {
    return adminRequest<ActivityEngineRaw>(`${ADMIN_API_BASE}/activity-engine`, { signedIn: true }).then(mappers.activityEngine)
}

export function getTasks(): Promise<TasksInfo> {
    return adminRequest<TasksRaw>(`${ADMIN_API_BASE}/tasks`, { signedIn: true }).then(mappers.tasks)
}

export function runTask(id: string, body: ConfirmBody): Promise<{ ok: true }> {
    return adminRequest<{ ok: true }>(`${ADMIN_API_BASE}/tasks/${encodeURIComponent(id)}/run`, { method: 'POST', body, signedIn: true })
}

export function getCache(): Promise<CacheInfo> {
    return adminRequest<CacheRaw>(`${ADMIN_API_BASE}/cache`, { signedIn: true }).then(mappers.cache)
}

export function clearCacheLayer(layer: string, body: ConfirmBody): Promise<{ ok: true; cleared: number }> {
    return adminRequest<{ ok: true; cleared: number }>(`${ADMIN_API_BASE}/cache/${encodeURIComponent(layer)}/clear`, { method: 'POST', body, signedIn: true })
}

/**
 * GET /api/admin/logs. The caller's AbortSignal (React Query's) rides through
 * adminRequest into both transports' fetch, so a superseded or unmounted view
 * cancels the request instead of spending server CPU on it; aborts surface as
 * AbortError, a silent cancellation for React Query, never an AdminApiError.
 */
export function getLogs(filters: LogsRequestFilters = {}, signal?: AbortSignal): Promise<LogsPage> {
    return adminRequest<LogsPageRaw>(`${ADMIN_API_BASE}/logs?${logsQueryParams(filters).toString()}`, { signedIn: true, signal }).then(mappers.logsPage)
}

export type LogsExportFormat = 'log' | 'ndjson'

/**
 * Downloads the filtered, redacted log export (GET, so no CSRF token). The
 * response is fetched with the admin transport's credentials and saved through
 * a blob anchor; the server caps the export at 5000 redacted lines.
 */
export async function downloadLogsExport(filters: LogsRequestFilters, format: LogsExportFormat): Promise<void> {
    const params = logsQueryParams(filters)
    params.set('format', format)
    const res = await currentTransport().fetch(`${ADMIN_API_BASE}/logs/export?${params.toString()}`, { method: 'GET', headers: {} })
    if (res.status < 200 || res.status >= 300) {
        throw new AdminApiError(res.status, errorMessage(await readBody(res), res.status))
    }
    const blob = new Blob([res.body], { type: format === 'ndjson' ? 'application/x-ndjson' : 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = logsExportName(format)
    a.click()
    URL.revokeObjectURL(url)
}

export interface LogsStreamHandlers {
    onLine: (line: LogLine) => void
    onOpen?: () => void
    /** closed: the browser gave up (the server refused the stream); otherwise it is reconnecting. */
    onError?: (error: Event, closed: boolean) => void
}

/**
 * Subscribe to the redacted log tail (SSE). A fresh connection only receives new
 * lines, so pass afterSeq from GET /logs to avoid a gap; EventSource resends
 * Last-Event-ID automatically when it reconnects. Returns a cleanup function.
 */
export function streamLogs(handlers: LogsStreamHandlers, afterSeq = 0): () => void {
    const transport = currentTransport()
    if (transport.streamLogs) {
        return transport.streamLogs(handlers as unknown as Parameters<NonNullable<typeof transport.streamLogs>>[0])
    }
    const source = new EventSource(`${ADMIN_API_BASE}/logs/stream${afterSeq > 0 ? `?after=${afterSeq}` : ''}`, { withCredentials: true })
    source.onopen = () => handlers.onOpen?.()
    source.onmessage = (event: MessageEvent<string>) => {
        try {
            handlers.onLine(mappers.logLine(JSON.parse(event.data) as LogLineRaw))
        } catch {
            // Malformed frame: skip rather than break the tail.
        }
    }
    source.onerror = (event: Event) => handlers.onError?.(event, source.readyState === EventSource.CLOSED)
    return () => source.close()
}

export function getSettings(): Promise<SettingsInfo> {
    return adminRequest<SettingsRaw>(`${ADMIN_API_BASE}/settings`, { signedIn: true }).then(mappers.settings)
}

/** Changed keys only; null resets a key to its default. Rejected as a whole on any invalid key. */
export function saveSettings(changes: Record<string, string | null>): Promise<{ saved: number; restartNeeded: string[]; settings: SettingsInfo }> {
    return adminRequest<SettingsSaveRaw>(`${ADMIN_API_BASE}/settings`, { method: 'PATCH', body: { changes }, signedIn: true })
        .then(r => ({ saved: r.saved ?? 0, restartNeeded: r.restartNeeded ?? [], settings: mappers.settings(r.settings) }))
}

/** Copies the current .env values of these keys into the dashboard store. */
export function adoptSettings(keys: string[]): Promise<{ copied: number; settings: SettingsInfo }> {
    return adminRequest<SettingsSaveRaw>(`${ADMIN_API_BASE}/settings/adopt`, { method: 'POST', body: { keys }, signedIn: true })
        .then(r => ({ copied: r.copied ?? 0, settings: mappers.settings(r.settings) }))
}

export function exportSettings(): Promise<SettingsExportRaw> {
    return adminRequest<SettingsExportRaw>(`${ADMIN_API_BASE}/settings/export`, { signedIn: true })
}

/** Without apply the server only returns the diff; nothing is written. */
export function importSettings(file: unknown, apply: boolean): Promise<SettingsImportRaw & { info?: SettingsInfo }> {
    return adminRequest<SettingsImportRaw>(`${ADMIN_API_BASE}/settings/import`, { method: 'POST', body: { file, apply }, signedIn: true })
        .then(r => (r.settings ? { ...r, info: mappers.settings(r.settings) } : r))
}

export function getAudit(cursor?: string): Promise<AuditPage> {
    return adminRequest<AuditPageRaw>(`${ADMIN_API_BASE}/audit${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signedIn: true }).then(mappers.auditPage)
}

export function verifyAuditChain(): Promise<AuditVerify> {
    return adminRequest<AuditVerifyRaw>(`${ADMIN_API_BASE}/audit/verify`, { signedIn: true }).then(mappers.auditVerify)
}

export function getAdminSessions(): Promise<AdminSessionsInfo> {
    return adminRequest<AdminSessionsRaw>(`${ADMIN_API_BASE}/sessions`, { signedIn: true }).then(mappers.sessions)
}

export function revokeAdminSession(id: string): Promise<{ ok: true; revoked: boolean }> {
    return adminRequest<{ ok: true; revoked: boolean }>(`${ADMIN_API_BASE}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', signedIn: true })
}

export function revokeAllAdminSessions(): Promise<{ ok: true; revoked: number }> {
    return adminRequest<{ ok: true; revoked: number }>(`${ADMIN_API_BASE}/sessions/revoke-all`, { method: 'POST', body: {}, signedIn: true })
}
