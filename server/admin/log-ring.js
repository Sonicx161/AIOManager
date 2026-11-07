import os from 'os'
import vm from 'node:vm'
import { redactAddresses } from './redact-ip.js'
import { accountHandle, platformKey } from '../utils/acct-handle.js'

// Dashboard log tail, built on an allowlist. Only messages that match an instance-level
// template below keep their text (then redacted); every other line is stored as time,
// level and category with a fixed "details hidden" marker, plus the error class and code
// when the line carried an error. There is no raw copy, so nothing can be unredacted.
const CAPACITY = 1000
const MAX_MSG = 400
export const MAX_LOG_VIEWERS = 8
const LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' }

const ring = []
let seq = 0
const listeners = new Set()

export const HIDDEN = 'details hidden'

const OWN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', os.hostname().toLowerCase()])
const ownHost = (host) => OWN_HOSTS.has(String(host).toLowerCase().replace(/:\d+$/, ''))

// Instance-level messages that keep their text. Anchored, with only counts, timings, enums,
// the instance's own paths and fixed wording as variables.
const KEEP = [
    /^Listening on port \d+$/,
    /^Path: .+[\\/]aio\.db$/,
    /^Zero-Knowledge mode active\./,
    /^READ_ONLY_REPLICA mode: [A-Za-z ,.():-]+$/,
    /^Custom HTML injection active\.$/,
    /^Initializing (SQLite at: .+[\\/]aio\.db|PostgreSQL\.\.\.)$/,
    /^Startup: (WAL checkpoint completed - cleared stale locks|Cleared stale PostgreSQL transactions)\.$/,
    /^Startup cleanup: (Reset in-memory state from previous session\.|marked \d+ orphaned command job\(s\) as failed \(server restarted\)\.)$/,
    /^(Running scheduled weekly VACUUM\.\.\.|VACUUM complete\.)$/,
    /^Migrated: Added [a-z_]+ column to [a-z_]+$/,
    /^Postgres Migration: Verified columns and types for encryption support\.$/,
    /^Autopilot Rule Stats: seeded \d+ missing rows\.$/,
    /^Autopilot Rules: backfilled platform='stremio' for \d+ rows\.$/,
    /^Server Credentials: backfilled (\d+ accounts from autopilot rules|credential_type for \d+ rows)\.$/,
    /^Activity cleanup: nulled \d+ implausible season values \(anime id pollution\)\.$/,
    /^account_api_keys: removed \d+ duplicate row\(s\) before creating the unique index\.$/,
    /^(Loaded persistent encryption key from data directory|Using ENCRYPTION_KEY from environment|Detected encryption key mismatch between \.env and data directory\. Added old key to fallback list|No ENCRYPTION_KEY found\. Generated a new random key and saved it to data directory)\.$/,
    /^Autonomous Engine (started\.|: Previous run still in progress\. Skipping cycle\.)/,
    /^Autonomous Engine: cycle stalled for \d+s \(deadline \d+s\)\./,
    /^Check Summary: Periodic health scan covered \d+ candidate rules in [\d.]+s\.( Budget held at \d+\/\d+\.)?$/,
    /^Rule cache: \d+ hits \/ \d+ misses \(\d+% hit\), ~[\d.]+MB of rule row reads saved from the DB$/,
    /^Rule decrypt cache: \d+ hits \/ \d+ misses \(\d+% hit\), ~[\d.]+MB of repeated AES-GCM decrypts avoided on steady rules$/,
    /^Write tripwire tripped \((statements|bytes)\): \d+ statements \(limit \d+\), \d+ bytes \(limit \d+\) in the last hour across \d+ active rule\(s\)\. Safe mode: no DB writes, provider pushes, swaps or webhooks until restart\.$/,
    /^Autopilot write safe mode active since [\dTZ:.-]+ \((statements|bytes)\); writes, pushes and webhooks stay off/,
    /^Activity engine (started \(interval: [\d.]+min, jitter: [\d.]+s\)|stopped\.|disabled\. Set ACTIVITY_ENGINE_ENABLED=true to enable background polling\.)$/,
    /^Activity scan complete: \d+ accounts scanned \(\d+ hash-skipped, \d+ breaker-skipped\), \d+ events, \d+ snapshot writes, \d+ snapshot deletes in \d+ms( \(budget exhausted\))?$/,
    /^Non-Stremio accounts \(Nuvio\/RealStream\/Hydra\) are present but not tracked by the activity scanner; only Stremio credentials are scanned\.$/,
    /^Dashboard enabled( \(setup required\))?\.$/,
    /^Dashboard: [A-Za-z0-9 ,.;:()'=_/-]+$/,
    /^ADMIN_ALLOW_IPS has \d+ unparseable entr(y|ies); they match nothing\.$/,
    /^(ADMIN_ENABLED is on but no Dashboard sign-in is configured|ADMIN_SECRET_HASH is not a valid hash|ADMIN_SECRET_HASH asks scrypt for more than 256 MiB|ADMIN_USERNAME is not a usable username|The stored Dashboard credential|Dashboard sign-in refused: X-Forwarded-\* headers arrived)[A-Za-z0-9 ,.;:()'=_/*-]*$/,
    /^(Fastify closed\.|Flushing and closing\.\.\.|Database connection closed cleanly\.|Waiting for autopilot worker to finish\.\.\.|Worker still running after 30s, proceeding with shutdown\.)$/,
]

// Error lines whose fixed prefix is useful; the variable part is hidden.
const KEEP_PREFIX = /^(Activity scan error|Startup Error|Worker Error|VACUUM failed|Migration step failed|Migration warning|Startup cleanup warning|Activity season cleanup failed|Command job startup cleanup failed|Audit write failed|Could not read the Dashboard credential|Write tripwire alert failed|Server Credentials backfill warning|Autopilot Rule Stats backfill warning|pg_terminate_backend cleanup failed|SQLite migration platform backfill|PG migration platform backfill|Unhandled error|Unhandled promise rejection|Uncaught exception|Error during shutdown|Lock state write failed)\b/

const RULES = [
    [/\bADMIN_CREDENTIALS\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n]*)/gi, 'ADMIN_CREDENTIALS=[redacted]'],
    // URLs keep the scheme; hosts other than the instance's own collapse to [host].
    [/\b([a-z][a-z0-9+.-]{1,15}):\/\/(?:[^\s/?#@"'<>]*@)?([^\s/?#"'<>]+)([^\s"'<>]*)/gi, (_, scheme, host, rest) => `${scheme}://${ownHost(host) ? host : '[host]'}${rest && rest !== '/' ? '/…' : ''}`],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
    [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, '[redacted]'],
    [/\b(auth[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passphrase|secret|authorization|cookie|session|x-sync-password|x-api-key)(\s*[:=]\s*)(["']?)[^\s"',;&]+\3/gi, '$1$2[redacted]'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email]'],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]'],
    [/\?[^\s"'<>]*/g, ''],
    [/\b[0-9a-f]{24,}\b/gi, '[redacted]'],
    [/(?<![A-Za-z0-9_\-+/=])[A-Za-z0-9_\-+/=]{32,}(?![A-Za-z0-9_\-+/=])/g, '[redacted]'],
]

export function redactText(input) {
    let s = String(input ?? '')
    if (s.length > MAX_MSG * 4) s = s.slice(0, MAX_MSG * 4)
    for (const [re, rep] of RULES) s = s.replace(re, rep)
    // Log text is allowlisted instance messages, so the sanitizer keeps its version-word
    // exemption here (audit wire text does not: it uses the strict variant).
    s = redactAddresses(s)
    s = s.replace(/[\r\n\t]+/g, ' ')
    return s.length > MAX_MSG ? s.slice(0, MAX_MSG) + '…' : s
}

const safeCategory = (c) => (typeof c === 'string' && /^[A-Za-z][A-Za-z0-9 _-]{0,23}$/.test(c) ? c : null)

// Structured lines (DP-12): call sites pass a fmt id plus typed fields next to category; the
// human msg stays stdout-only. Formatted entries store only the rendered template, and any
// missing or invalid field fails the whole line closed to the hidden fallback, never a
// partial render. Validators return the rendered string or null (fail).
const COUNT_MAX = 1_000_000_000
const MS_MAX = 86_400_000
const REF_RE = /^ad_[0-9a-f]{16}$/
const SIGNAL_LABEL_RE = /^[a-z][A-Za-z0-9_-]{0,31}$/
const LIST_MAX = 16
const SIGNAL_MAX = 64
const ACCT_MAX = 256
const PLATFORM_MAX = 32

const intIn = (min, max) => (v) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? String(v) : null)
const oneOf = (values) => (v) => (typeof v === 'string' && values.includes(v) ? v : null)
const platformField = (v) => (typeof v === 'string' && v !== '' && v.length <= PLATFORM_MAX ? platformKey(v) : null)
const platformList = (v) => {
    if (!Array.isArray(v) || v.length === 0 || v.length > LIST_MAX) return null
    const keys = []
    for (const p of v) {
        if (typeof p !== 'string' || p === '' || p.length > PLATFORM_MAX) return null
        const k = platformKey(p)
        if (!keys.includes(k)) keys.push(k)
    }
    return keys.join(', ')
}
const acctField = (v) => {
    if (v == null || v === '') return 'client'
    if (typeof v !== 'string' || v.length > ACCT_MAX) return null
    return /^acct-[0-9a-f]{12}$/.test(v) ? v : accountHandle(v)
}
const refField = (v) => (typeof v === 'string' && REF_RE.test(v) ? v : null)
const signalCounts = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const labels = Object.keys(v)
    if (labels.length === 0 || labels.length > SIGNAL_MAX) return null
    const parts = []
    for (const label of labels) {
        const n = v[label]
        if (!SIGNAL_LABEL_RE.test(label)) return null
        const count = intIn(0, COUNT_MAX)(n)
        if (count === null) return null
        parts.push(`${label}=${count}`)
    }
    return parts.length > 0 ? parts.join(' ') : null
}
const errClass = (v, obj) => {
    const t = typeof v === 'string' && v !== '' ? v : obj?.err?.type
    return typeof t === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(t) ? t : null
}
const errCodeSuffix = (v, obj) => {
    const c = typeof v === 'string' && v !== '' ? v : obj?.err?.code
    if (c == null) return ''
    return typeof c === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(c) ? ` code ${c}` : null
}
const ctxSuffix = (v) => {
    if (v == null) return ''
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    let s = ''
    if (v.attempt != null || v.max != null) {
        const attempt = intIn(1, 1000)(v.attempt)
        const max = intIn(1, 1000)(v.max)
        if (attempt === null || max === null) return null
        s = ` at attempt ${attempt} of ${max}`
    }
    if (v.status != null) {
        const status = intIn(100, 599)(v.status)
        if (status === null) return null
        s += `${s ? ',' : ''} status ${status}`
    }
    return s
}
const failNote = (v) => {
    if (v == null) return ''
    const platforms = platformList(v)
    return platforms === null ? null : `; push failed: ${platforms}`
}

// The n-failed-checks clause of ap.swap is omitted: no consecutive-failure counter exists at
// the call site (autopilot_rule_stats has none), and the spec says omit rather than guess.
const FORMATTERS = {
    Sync: {
        'sync.action': { t: 'sync: {action} for {acct} ({platform})', f: { action: oneOf(['pull', 'push', 'library-get', 'library-put', 'library-meta', 'profile-get', 'profile-set', 'user-get']), acct: acctField, platform: platformField } },
        'sync.library_put': { t: 'sync: library put {n} item(s) for {acct}, result {result}, removed {removed}', f: { n: intIn(0, COUNT_MAX), acct: acctField, result: oneOf(['ok', 'error']), removed: intIn(0, COUNT_MAX) } },
        'sync.shrink_guard': { t: 'sync: shrink guard held for {acct}: {before} -> {after} addons, attempt {attempt} of {max}, kept last-good', f: { acct: acctField, before: intIn(0, COUNT_MAX), after: intIn(0, COUNT_MAX), attempt: intIn(1, 1000), max: intIn(1, 1000) } },
        'sync.last_good': { t: 'sync: served last-good collection for {acct} after {reason}', f: { acct: acctField, reason: oneOf(['upstream-error', 'timeout', 'invalid-refresh', 'shrink-suspect']) } },
        'sync.auth_rejected': { t: 'sync: pull rejected for {acct}: password mismatch', f: { acct: acctField } },
        'sync.zk_upgrade': { t: 'sync: upgraded {acct} to Zero-Knowledge storage ({ms} ms)', f: { acct: acctField, ms: intIn(0, MS_MAX) } },
        'sync.canonical_skip': { t: 'sync: canonical write skipped for {acct}: {reason}', f: { acct: acctField, reason: oneOf(['other-workspace', 'empty-push']) } },
        'sync.error': { t: 'sync: {op} failed for {acct}: class {cls}{code}{ctx}', f: { op: oneOf(['pull', 'push', 'restore', 'batch-check']), acct: acctField, cls: errClass, code: errCodeSuffix, ctx: ctxSuffix } },
    },
    Autopilot: {
        'ap.swap': { t: 'autopilot: {acct} switched active tier {from} -> {to} (platforms: {platforms})', f: { acct: acctField, from: refField, to: refField, platforms: platformList } },
        'ap.recovery': { t: 'autopilot: {acct} restored primary tier {to} after recovery (platforms: {platforms})', f: { acct: acctField, to: refField, platforms: platformList } },
        'ap.push': { t: 'autopilot: pushed {n} addon(s) for {acct}, active {ref} (platforms: {platforms}{failnote})', f: { n: intIn(0, COUNT_MAX), acct: acctField, ref: refField, platforms: platformList, failnote: failNote } },
        'ap.enforce_skip': { t: 'autopilot: enforcement skipped for {acct}: {reason}', f: { acct: acctField, reason: oneOf(['chain-guard', 'no-chain', 'no-connection', 'rule-changed', 'undecryptable']) } },
        'ap.auth_expired': { t: 'autopilot: {acct} auth key rejected (401); rule disabled', f: { acct: acctField } },
        'ap.push_failed': { t: 'autopilot: push failed for {acct} ({platform}): class {cls}{code}{ctx}', f: { acct: acctField, platform: platformField, cls: errClass, code: errCodeSuffix, ctx: ctxSuffix } },
        'ap.health_signals': { t: 'autopilot: health signals this cycle: {signals}; targets {targets}, bytes {bytes}', f: { signals: signalCounts, targets: intIn(0, COUNT_MAX), bytes: intIn(0, 1e12) } },
        'ap.egress_breaker': { t: 'autopilot: egress breaker tripped: {failed} of {domains} domains failing transport ({resolver}); deferring transport verdicts this cycle', f: { failed: intIn(0, COUNT_MAX), domains: intIn(1, COUNT_MAX), resolver: oneOf(['resolver errors']) } },
    },
}

function lookupFormatter(category, fmtId) {
    if (typeof category !== 'string' || typeof fmtId !== 'string') return null
    if (!Object.hasOwn(FORMATTERS, category)) return null
    const group = FORMATTERS[category]
    if (!Object.hasOwn(group, fmtId)) return null
    const spec = group[fmtId]
    return spec && typeof spec.t === 'string' && spec.f && typeof spec.f === 'object' ? spec : null
}

function renderStructured(spec, obj) {
    try {
        return renderSpec(spec, obj)
    } catch {
        let err = null
        try { err = obj?.err } catch { return HIDDEN }
        return hiddenWithError(err)
    }
}

function renderSpec(spec, obj) {
    const values = {}
    for (const [name, validate] of Object.entries(spec.f)) {
        const rendered = validate(obj[name], obj)
        if (rendered === null) return hiddenWithError(obj.err)
        values[name] = rendered
    }
    const out = spec.t.replace(/\{(\w+)\}/g, (m, name) => (name in values ? values[name] : m))
    if (/\{\w+\}/.test(out)) return hiddenWithError(obj.err)
    return redactText(out)
}

function hiddenWithError(err) {
    if (!err || typeof err !== 'object') return HIDDEN
    let type, code
    try {
        type = err.type
        code = err.code
    } catch {
        return HIDDEN
    }
    const cls = typeof type === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(type) ? type : null
    const tagCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : null
    const tag = [cls, tagCode].filter(Boolean).join(', ')
    return tag ? `${HIDDEN} (${tag})` : HIDDEN
}

export function allowlistMessage(raw, err = null) {
    const text = String(raw ?? '').replace(/[\r\n\t]+/g, ' ').trim()
    if (KEEP.some((re) => re.test(text))) return redactText(text)
    const prefix = KEEP_PREFIX.exec(text)
    if (prefix) return `${prefix[1]}: ${HIDDEN}`
    return hiddenWithError(err)
}

const MIN_LEVEL = 30
const levelOf = (line) => { const m = /"level":(\d+)/.exec(line); return m ? Number(m[1]) : null }

// Search caps: q and pattern length, page size, export size, regex watchdog budget.
const MAX_QUERY = 256
const MAX_PAGE = 500
const MAX_EXPORT = 5000
const REGEX_TIMEOUT_MS = 50

// The user pattern compiles and runs inside node:vm so catastrophic backtracking hits
// the watchdog instead of the event loop. The script source is fixed; the pattern is data.
const REGEX_MATCHER = new vm.Script(
    'const re = new RegExp(__pattern, "i")\n__hits = []\nfor (let i = 0; i < __texts.length; i++) if (re.test(__texts[i])) __hits.push(i)',
    { filename: 'log-regex-filter.js' }
)

function regexHits(pattern, texts) {
    const sandbox = { __pattern: pattern, __texts: texts, __hits: null }
    try {
        REGEX_MATCHER.runInNewContext(sandbox, { timeout: REGEX_TIMEOUT_MS })
    } catch (err) {
        if (err?.name === 'SyntaxError') return { error: 'regex_invalid' }
        return { error: String(err?.message || '').includes('timed out') ? 'regex_timeout' : 'regex_invalid' }
    }
    return { hits: new Set(sandbox.__hits) }
}

const WIRE_ORDER = ['info', 'warn', 'error']

// Shared pipeline for GET /logs and the export: one pass over the redacted ring with the
// level/module/since/cursor/after filters plus the compiled search. Returns the ascending
// matches and the whole-ring levels counts and module list, or a 400-style error.
function filterRing({ after = 0, cursor = 0, level = null, module: moduleName = null, since = 0, q = null, regex = false } = {}) {
    const levels = { all: 0, info: 0, warn: 0, error: 0 }
    const modules = new Set()
    for (const e of ring) {
        levels.all++
        levels[WIRE_LEVEL[e.level] || 'info']++
        modules.add(e.category || 'server')
    }
    let hits = null
    let needle = null
    if (typeof q === 'string' && q !== '') {
        if (q.length > MAX_QUERY) return { error: 'query_too_long' }
        if (regex) {
            const res = regexHits(q, ring.map((e) => e.msg))
            if (res.error) return res
            hits = res.hits
        } else needle = q.toLowerCase()
    }
    const minLevel = WIRE_ORDER.includes(level) ? WIRE_ORDER.indexOf(level) : 0
    const mod = typeof moduleName === 'string' && moduleName !== '' ? moduleName : null
    const afterSeq = Number(after) || 0
    const beforeSeq = Number(cursor) || 0
    const sinceTs = Number(since) || 0
    const entries = []
    for (let i = 0; i < ring.length; i++) {
        const e = ring[i]
        if (e.seq <= afterSeq) continue
        if (beforeSeq > 0 && e.seq >= beforeSeq) continue
        if (WIRE_ORDER.indexOf(WIRE_LEVEL[e.level] || 'info') < minLevel) continue
        if (mod && (e.category || 'server') !== mod) continue
        if (sinceTs > 0 && e.ts < sinceTs) continue
        if (needle !== null && !e.msg.toLowerCase().includes(needle)) continue
        if (hits !== null && !hits.has(i)) continue
        entries.push(e)
    }
    return { entries, levels, modules: [...modules].sort() }
}

// Turns one pino JSON line into the only shape the ring ever stores. Anything that throws
// while reading the object (hostile getters from direct callers) drops the line.
export function toEntry(line) {
    try {
        return entryFrom(line)
    } catch {
        return null
    }
}

function entryFrom(line) {
    let obj
    try { obj = typeof line === 'string' ? JSON.parse(line) : line } catch { return null }
    if (!obj || typeof obj !== 'object') return null
    if (Number(obj.level) < MIN_LEVEL) return null
    const raw = typeof obj.msg === 'string' && obj.msg ? obj.msg : ''
    if (!raw && !obj.err && typeof obj.fmt !== 'string') return null
    // Formatted entries render from validated fields only; the msg is ignored. Unknown or
    // foreign fmt ids fall through to the allowlist exactly as before.
    let msg
    const spec = lookupFormatter(obj.category, obj.fmt)
    if (spec) msg = renderStructured(spec, obj)
    else msg = allowlistMessage(raw, obj.err)
    return {
        ts: Number.isFinite(obj.time) ? obj.time : Date.now(),
        level: LEVELS[obj.level] || 'info',
        category: safeCategory(obj.category),
        msg,
    }
}

export function ingestLogLine(chunk) {
    const text = String(chunk)
    for (const line of text.split('\n')) {
        if (!line) continue
        const level = levelOf(line)
        if (level !== null && level < MIN_LEVEL) continue
        let entry
        try { entry = toEntry(line) } catch { entry = null }
        if (!entry) continue
        entry.seq = ++seq
        ring.push(entry)
        if (ring.length > CAPACITY) ring.shift()
        for (const fn of listeners) {
            try { fn(entry) } catch { /* a broken listener never blocks logging */ }
        }
    }
}

export function readLogs({ after = 0, level = null, limit = 200 } = {}) {
    const order = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
    const min = level && order.includes(level) ? order.indexOf(level) : 0
    const size = Math.max(1, Math.min(CAPACITY, Number(limit) || 200))
    const items = ring.filter((e) => e.seq > (Number(after) || 0) && order.indexOf(e.level) >= min)
    return { items: items.slice(-size), lastSeq: seq, capacity: CAPACITY }
}

// Wire shape shared by GET /logs and the SSE frames. The UI has three levels: debug and
// trace read as info, fatal as error.
const WIRE_LEVEL = { trace: 'info', debug: 'info', info: 'info', warn: 'warn', error: 'error', fatal: 'error' }

export const toWireLine = (e) => ({ seq: e.seq, at: new Date(e.ts).toISOString(), level: WIRE_LEVEL[e.level] || 'info', module: e.category || 'server', message: e.msg })

export function logsPage({ after = 0, cursor = 0, level = null, limit = 200, module: moduleName = null, since = 0, q = null, regex = false } = {}) {
    const filtered = filterRing({ after, cursor, level, module: moduleName, since, q, regex })
    if (filtered.error) return filtered
    const size = Math.max(1, Math.min(MAX_PAGE, Number(limit) || 200))
    const page = filtered.entries.slice(-size)
    const nextCursor = filtered.entries.length > page.length && page.length ? page[0].seq : null
    return { lines: page.map(toWireLine), levels: filtered.levels, modules: filtered.modules, bufferSize: CAPACITY, lastSeq: seq, nextCursor }
}

// The export walks the same redacted ring with the same filters, newest 5000 kept, oldest first.
export function logsForExport(filters = {}) {
    const filtered = filterRing(filters)
    if (filtered.error) return filtered
    return { lines: filtered.entries.slice(-MAX_EXPORT).map(toWireLine) }
}

export function subscribeLogs(fn) {
    if (listeners.size >= MAX_LOG_VIEWERS) return null
    listeners.add(fn)
    return () => listeners.delete(fn)
}

export const logListenerCount = () => listeners.size

export function resetLogRing() {
    ring.length = 0
    seq = 0
    listeners.clear()
}

// Wraps the logger destination so every line is also offered to the ring.
export function teeLogStream(destination) {
    return {
        write(chunk) {
            const ok = destination.write(chunk)
            try { ingestLogLine(chunk) } catch { /* never let the tap break logging */ }
            return ok
        },
    }
}
