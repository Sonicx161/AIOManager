// Dashboard view of the env registry: labels, control types, units, live or restart, and the
// keys that can only come from the environment. Pure (no db or config imports) so the boot
// preload can use checkSettingValue before lib/env.js reads process.env.
import { ENV_META, ENV_GROUPS, BOOL_LITERALS, TRUTHY } from '../lib/env-schema.js'

// KEY and HASH only as the last word, so ACTIVITY_HASH_CACHE_TTL_MS stays a plain number.
export const SECRET_NAME_RE = /SECRET|TOKEN|PASSWORD|CREDENTIALS|DSN|DATABASE_URL|WEBHOOK_URL|_KEY$|_HASH$/
export const MAX_TEXT_LENGTH = 8192

// Returned by unauthenticated endpoints (lib/public-config.js), so never secret.
export const PUBLIC_SETTING_KEYS = ['CUSTOM_HTML', 'REGISTRATIONS_CLOSED']
const LONG_TEXT = new Set(['CUSTOM_HTML'])

export const isSecretSetting = (key) => SECRET_NAME_RE.test(key) && !PUBLIC_SETTING_KEYS.includes(key)

// Read before the database opens, or they protect the database or the Dashboard itself.
export const ENV_ONLY = {
    DATA_DIR: 'Holds the database file and server_secret.key, so it is needed before the stored settings can be read.',
    DB_TYPE: 'Picks the database the stored settings live in, so it is needed before they can be read.',
    DATABASE_URL: 'Connects to the database the stored settings live in, so it is needed before they can be read.',
    DB_SSL_REJECT_UNAUTHORIZED: 'Used to open the database connection, before the stored settings can be read.',
    DB_POOL_SIZE: 'Used to open the database connection, before the stored settings can be read.',
    DB_CONNECTION_TIMEOUT: 'Used to open the database connection, before the stored settings can be read.',
    DB_MAX_RETRIES: 'Used to open the database connection, before the stored settings can be read.',
    READ_ONLY_REPLICA: 'Decides whether this database may be written at all. A stored value could turn a standby into a second writer.',
    ENCRYPTION_KEY: 'Encrypts the database, including stored secrets, so it cannot be stored in it.',
    ADMIN_ENABLED: 'Turns the Dashboard on. Read before the database opens, and turning it off here would leave no way back.',
    ADMIN_CREDENTIALS: 'The Dashboard sign-in. Set in .env; a signed-in session must not be able to replace the credential that guards it.',
    ADMIN_SECRET_HASH: 'The Dashboard sign-in. A signed-in session must not be able to replace the credential that guards it.',
    ADMIN_USERNAME: 'The Dashboard sign-in. A signed-in session must not be able to replace the credential that guards it.',
    ADMIN_SETUP: 'Controls how the Dashboard sign-in is first created, before any session exists.',
    ADMIN_ALLOW_IPS: 'Guards who can reach the Dashboard. A signed-in session must not be able to widen its own gate.',
    ADMIN_ALLOW_HTTP_LAN: 'Guards how the Dashboard sign-in travels. A signed-in session must not be able to weaken it.',
    TRUST_PROXY_HOPS: 'Decides which client address the Dashboard allowlist and lockouts see. A signed-in session must not be able to change it.',
    TRUSTED_PROXY_CIDRS: 'Decides which hosts may supply client addresses to the Dashboard allowlist and lockouts. A signed-in session must not be able to change it.',
    TRUST_PRIVATE_NETWORKS: 'Decides whether hosts on your own network may supply client addresses to the Dashboard allowlist and lockouts. A signed-in session must not be able to change it.',
    AIOMAN_TRACE: 'Writes request traces to disk. The Dashboard never starts capturing user traffic.',
    SQLITE_DB_PATH: 'Set by the server at boot from DATA_DIR.',
}
export const INTERNAL_SETTINGS = new Set(['SQLITE_DB_PATH'])

// Read per request or wired in admin/settings.js; every other key applies on the next start.
export const LIVE_SETTINGS = new Set(['REGISTRATIONS_CLOSED', 'UNIFIED_ENFORCEMENT', 'CUSTOM_HTML', 'LOG_LEVEL'])

const SELECT_OPTIONS = { NODE_ENV: ['production', 'development'] }

export const LABELS = {
    PORT: 'Port',
    NODE_ENV: 'Runtime mode',
    DATA_DIR: 'Data directory',
    MAX_SYNC_PAYLOAD_SIZE: 'Max sync payload',
    DB_TYPE: 'Database engine',
    DATABASE_URL: 'PostgreSQL connection string',
    DB_SSL_REJECT_UNAUTHORIZED: 'Verify database certificate',
    DB_POOL_SIZE: 'Pool size',
    DB_CONNECTION_TIMEOUT: 'Connection timeout',
    DB_MAX_RETRIES: 'Connection attempts',
    READ_ONLY_REPLICA: 'Read-only replica',
    ENCRYPTION_KEY: 'Encryption key',
    CORS_ORIGINS: 'Allowed origins',
    SSRF_ALLOW_PRIVATE: 'Allow private addresses',
    TRUST_PROXY: 'Trust proxy headers',
    CUSTOM_HTML: 'Custom sign-in HTML',
    REGISTRATIONS_CLOSED: 'Close registrations',
    UNIFIED_ENFORCEMENT: 'Unified enforcement',
    ADMIN_ENABLED: 'Dashboard',
    ADMIN_CREDENTIALS: 'Dashboard username and password',
    ADMIN_SECRET_HASH: 'Dashboard password hash',
    ADMIN_USERNAME: 'Dashboard username',
    ADMIN_SETUP: 'Dashboard setup mode',
    ADMIN_ALLOW_IPS: 'Dashboard allowlist',
    ADMIN_ALLOW_HTTP_LAN: 'Allow HTTP on the LAN',
    TRUST_PROXY_HOPS: 'Proxy hops',
    TRUSTED_PROXY_CIDRS: 'Trusted proxies',
    LOG_LEVEL: 'Log level',
    LOG_PRETTY_PRINT: 'Pretty-print logs',
    PROXY_CONCURRENCY_LIMIT: 'Proxy concurrency',
    AIOSTREAMS_USER_API_THROTTLE_MS: 'AIOStreams API throttle',
    IMAGE_PROXY_TIMEOUT_MS: 'Image proxy timeout',
    IMAGE_PROXY_QUEUE_LIMIT: 'Image proxy queue',
    IMAGE_PROXY_THROTTLE_MS: 'Image proxy throttle',
    IMAGE_CACHE_TTL_MS: 'Poster cache lifetime',
    IMAGE_CACHE_MAX_BYTES: 'Poster cache size',
    IMAGE_CACHE_MAX_ITEM_BYTES: 'Largest cached poster',
    DATASTORE_META_BATCH_MAX: 'Library check batch size',
    DATASTORE_META_BATCH_CONCURRENCY: 'Library check concurrency',
    DATASTORE_META_BATCH_ENTRY_TIMEOUT_MS: 'Library check timeout',
    ACTIVITY_ENGINE_ENABLED: 'Activity engine',
    ACTIVITY_SCAN_INTERVAL_MS: 'Scan interval',
    ACTIVITY_SCAN_JITTER_MS: 'Scan jitter',
    ACTIVITY_INITIAL_DELAY_MS: 'First scan delay',
    ACTIVITY_CYCLE_BUDGET_MS: 'Cycle time budget',
    ACTIVITY_MAX_ACCOUNTS_PER_CYCLE: 'Accounts per cycle',
    ACTIVITY_MAX_EVENTS_PER_CYCLE: 'Events per cycle',
    ACTIVITY_MAX_SNAPSHOT_WRITES_PER_CYCLE: 'Snapshot writes per cycle',
    ACTIVITY_BATCH_SIZE: 'Write batch size',
    ACTIVITY_FETCH_TIMEOUT_MS: 'Fetch timeout',
    ACTIVITY_HASH_CACHE_TTL_MS: 'State cache lifetime',
    ACTIVITY_HASH_CACHE_MAX: 'State cache accounts',
    ACTIVITY_SCAN_CONCURRENCY: 'Scan concurrency',
    ACTIVITY_BREAKER_THRESHOLD: 'Breaker threshold',
    ACTIVITY_BREAKER_BASE_MS: 'Breaker first backoff',
    ACTIVITY_BREAKER_MAX_MS: 'Breaker max backoff',
    AUTOPILOT_SCAN_CHUNK_SIZE: 'Rules scanned per cycle',
    AUTOPILOT_MAX_RULES_PER_CYCLE: 'Rule cap per cycle',
    AUTOPILOT_CYCLE_BUDGET_MS: 'Cycle time budget',
    AUTOPILOT_HEALTH_CACHE_TTL_MS: 'Health cache lifetime',
    AUTOPILOT_MANIFEST_PROBES_PER_HOST: 'Manifest checks per host',
    AUTOPILOT_MANIFEST_CHECK_INTERVAL_MS: 'Manifest check interval',
    AUTOPILOT_MANIFEST_CHECKS_PER_HOST_PER_MINUTE: 'Manifest checks per host per minute',
    AUTOPILOT_RULE_CONCURRENCY: 'Rule concurrency',
    AUTOPILOT_RULE_RECHECK_MS: 'Rule recheck interval',
    AUTOPILOT_RULE_CACHE_MAX_BYTES: 'Rule cache size',
    AUTOPILOT_RULE_CACHE_TTL_MS: 'Rule cache lifetime',
    AUTOPILOT_WRITE_TRIPWIRE: 'Write tripwire',
    AUTOPILOT_WRITE_TRIPWIRE_PER_HOUR: 'Tripwire statements per hour',
    AUTOPILOT_WRITE_TRIPWIRE_BYTES_PER_HOUR: 'Tripwire bytes per hour',
    AUTOPILOT_OWNER_WRITES_PER_HOUR: 'Owner writes per hour',
    AUTOPILOT_OWNER_ADDON_LIST_BYTES_PER_HOUR: 'Owner addon list bytes per hour',
    AUTOPILOT_TRIPWIRE_WEBHOOK_URL: 'Tripwire alert webhook',
    SQLITE_DB_PATH: 'SQLite file path',
    AIOMAN_TRACE: 'Request tracing',
}

const GROUP_TITLES = {
    'ESSENTIAL SETUP': ['essential', 'Essential setup'],
    DATABASE: ['database', 'Database'],
    SECURITY: ['security', 'Security'],
    'DASHBOARD (OPT-IN)': ['dashboard', 'Dashboard (opt-in)'],
    LOGGING: ['logging', 'Logging'],
    'PROXY & IMAGE CACHING': ['proxy', 'Proxy & image caching'],
    'ACTIVITY ENGINE (OPT-IN)': ['activity', 'Activity engine (opt-in)'],
    'AUTOPILOT ENGINE': ['autopilot', 'Autopilot engine'],
    'INTERNAL / DEBUG': ['internal', 'Internal / debug'],
}

export const SETTING_GROUPS = (() => {
    const grouped = new Set()
    const groups = ENV_GROUPS.map((g) => {
        const [id, title] = GROUP_TITLES[g.title] || [g.title.toLowerCase().replace(/[^a-z]+/g, '-'), g.title]
        const keys = g.vars.filter((v) => ENV_META[v])
        keys.forEach((k) => grouped.add(k))
        return { id, title, note: g.note ?? null, keys }
    })
    const rest = Object.keys(ENV_META).filter((k) => !grouped.has(k))
    if (rest.length) groups.push({ id: 'other', title: 'Other', note: null, keys: rest })
    return groups
})()

const DURATION_UNITS = [['h', 3_600_000], ['min', 60_000], ['s', 1000]]
const BYTE_UNITS = [['MB', 1_048_576], ['KB', 1024]]

// Largest unit that divides the default (and, for durations, the minimum), so every value
// the control can produce stays a whole number in that unit.
function unitFor(key, meta) {
    if (meta.type !== 'integer') return null
    const def = Number(meta.default) || 0
    if (/_MS$/.test(key)) {
        const min = meta.min || 0
        const hit = DURATION_UNITS.find(([, f]) => def % f === 0 && min % f === 0)
        return hit ? { label: hit[0], factor: hit[1] } : { label: 'ms', factor: 1 }
    }
    if (/_BYTES(?:_|$)|_SIZE$/.test(key) && key !== 'DB_POOL_SIZE' && key !== 'ACTIVITY_BATCH_SIZE' && key !== 'AUTOPILOT_SCAN_CHUNK_SIZE') {
        const hit = BYTE_UNITS.find(([, f]) => def % f === 0)
        return hit ? { label: hit[0], factor: hit[1] } : { label: 'B', factor: 1 }
    }
    return null
}

// First sentence for the one-line row; the rest opens with More. Skips "e.g." style stops.
export function splitDescription(desc) {
    const text = String(desc || '')
    const re = /\.\s+(?=[A-Z0-9"(])/g
    let m
    while ((m = re.exec(text))) {
        const before = text.slice(Math.max(0, m.index - 4), m.index + 1)
        if (/\b(?:e\.g|i\.e|etc|vs)\.$/i.test(before)) continue
        return { summary: text.slice(0, m.index + 1), more: text.slice(m.index + 1).trim() }
    }
    return { summary: text, more: '' }
}

export function settingSpec(key) {
    // Own keys only, so __proto__ or constructor never resolve to a setting.
    if (typeof key !== 'string' || !Object.hasOwn(ENV_META, key)) return null
    const meta = ENV_META[key]
    const secret = isSecretSetting(key)
    let type
    if (secret) type = 'secret'
    else if (meta.type === 'boolean') type = 'boolean'
    else if (meta.allowed || SELECT_OPTIONS[key]) type = 'select'
    else if (meta.type === 'integer') type = 'number'
    else if (meta.type === 'comma-separated list') type = 'list'
    else if (LONG_TEXT.has(key)) type = 'longtext'
    else type = 'text'
    const spec = {
        key,
        label: LABELS[key] || key,
        type,
        secret,
        apply: LIVE_SETTINGS.has(key) ? 'live' : 'restart',
        envOnly: Boolean(ENV_ONLY[key]),
        envOnlyReason: ENV_ONLY[key] || null,
        internal: INTERNAL_SETTINGS.has(key),
        description: meta.desc,
        ...splitDescription(meta.desc),
    }
    if (type === 'select') spec.options = meta.allowed || SELECT_OPTIONS[key]
    if (meta.min !== undefined) spec.min = meta.min
    if (meta.max !== undefined) spec.max = meta.max
    const unit = unitFor(key, meta)
    if (unit) spec.unit = unit
    if (!secret) {
        spec.default = meta.default === null || meta.default === undefined ? null : Array.isArray(meta.default) ? meta.default.join(',') : String(meta.default)
        if (meta.defaultLabel) spec.defaultLabel = meta.defaultLabel
    }
    return spec
}

export const SETTING_KEYS = Object.keys(ENV_META)

// Canonical form every audit change key is folded to before any lookup: trimmed,
// upper-cased, inner whitespace runs collapsed to the underscore separator.
export function canonicalSettingKey(key) {
    if (typeof key !== 'string') return null
    const k = key.trim().toUpperCase().replace(/\s+/g, '_')
    return k || null
}

const AUDIT_VALUE_TYPES = new Set(['boolean', 'select', 'number'])

// Audit wire allowlist: from/to values cross the wire only for registry keys with a
// closed value type (boolean, enum, integer/duration) that are not secrets. Strings,
// lists, URLs, secrets and every unknown, legacy or imported key read "changed".
export function auditSettingChange(key) {
    const canonical = canonicalSettingKey(key)
    if (!canonical) return { key: null, showValues: false }
    const spec = settingSpec(canonical)
    return { key: canonical, showValues: Boolean(spec) && !spec.secret && AUDIT_VALUE_TYPES.has(spec.type) }
}

const fmtInt = (n, unit) => (unit && unit.factor > 1 && n % unit.factor === 0 ? `${n / unit.factor} ${unit.label}` : String(n))

// Normalizes one dashboard value to the string stored and put in process.env, or explains
// why it is refused. Covers what the env schema checks plus the minimum the schema only clamps.
export function checkSettingValue(key, input) {
    const spec = settingSpec(key)
    if (!spec) return { error: 'Unknown setting.' }
    if (spec.envOnly) return { error: 'Set in .env only.' }
    if (input === null || input === undefined) return { error: 'Enter a value, or reset it to the default.' }
    if (typeof input === 'object') return { error: 'Enter a single value.' }
    const raw = typeof input === 'string' ? input.trim() : String(input)
    if (spec.type === 'boolean') {
        const v = raw.toLowerCase()
        if (!BOOL_LITERALS.includes(v)) return { error: 'Must be on or off.' }
        return { value: TRUTHY.includes(v) ? 'true' : 'false' }
    }
    if (spec.type === 'number') {
        if (!/^-?\d+$/.test(raw)) return { error: 'Enter a whole number.' }
        const n = Number(raw)
        if (!Number.isSafeInteger(n)) return { error: 'Enter a smaller number.' }
        const lo = spec.min
        const hi = spec.max
        if (lo !== undefined && hi !== undefined && (n < lo || n > hi)) return { error: `Must be between ${fmtInt(lo, spec.unit)} and ${fmtInt(hi, spec.unit)}.` }
        if (lo !== undefined && n < lo) return { error: `Must be at least ${fmtInt(lo, spec.unit)}.` }
        if (hi !== undefined && n > hi) return { error: `Must be at most ${fmtInt(hi, spec.unit)}.` }
        return { value: String(n) }
    }
    if (spec.type === 'select') {
        if (!spec.options.includes(raw)) return { error: `Must be one of: ${spec.options.join(', ')}.` }
        return { value: raw }
    }
    if (!raw) return { error: 'Enter a value, or reset it to the default.' }
    if (raw.length > MAX_TEXT_LENGTH) return { error: `Must be at most ${MAX_TEXT_LENGTH} characters.` }
    // eslint-disable-next-line no-control-regex
    if (spec.type !== 'longtext' && /[\u0000-\u001f\u007f]/.test(raw)) return { error: 'Must be a single line.' }
    if (spec.type === 'list') {
        const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
        if (!parts.length) return { error: 'Enter at least one entry.' }
        if (parts.some((p) => /\s/.test(p))) return { error: 'Entries cannot contain spaces.' }
        return { value: parts.join(',') }
    }
    if (key === 'AUTOPILOT_TRIPWIRE_WEBHOOK_URL') {
        let url
        try { url = new URL(raw) } catch { return { error: 'Must be an http or https URL.' } }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'Must be an http or https URL.' }
    }
    return { value: raw }
}
