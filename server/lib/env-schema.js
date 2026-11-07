// Declarations only: the zod schema, defaults, descriptions and groups for every server
// environment variable. No side effects, so the boot preload can validate stored values
// before lib/env.js reads process.env.

import path from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data')

export const TRUTHY = ['1', 'true', 'yes', 'on']
export const BOOL_LITERALS = [...TRUTHY, '0', 'false', 'no', 'off']

// ---------------------------------------------------------------------------
// Field builders: each returns { schema, meta } so .env.example can be
// generated from the same definition that validates at runtime.
// ---------------------------------------------------------------------------

function int(def, { min, max, clampBelowMin } = {}, desc) {
    let schema = z
        .number({ error: 'must be a number' })
        .int({ error: 'must be a whole number' })
    if (min !== undefined && !clampBelowMin) schema = schema.min(min, { error: `must be >= ${min}` })
    if (max !== undefined) schema = schema.max(max, { error: `must be <= ${max}` })

    let preprocessor = (raw) => (raw == null || raw === '' ? def : Number(raw))

    // Add clamping preprocessor for legacy Math.max behavior
    if (clampBelowMin && min !== undefined) {
        preprocessor = (raw) => {
            const value = (raw == null || raw === '' ? def : Number(raw))
            if (value < min) {
                console.warn(`Environment variable value ${value} is below minimum ${min}, clamping to ${min}`)
                return min
            }
            return value
        }
    }

    return {
        schema: z
            .preprocess(preprocessor, schema)
            .describe(desc),
        meta: { type: 'integer', default: def, ...(min !== undefined && { min }), ...(max !== undefined && { max }), desc, ...(clampBelowMin && { clampBelowMin: true }) },
    }
}

function bool(def, desc) {
    return {
        schema: z
            .preprocess(
                (raw) => (raw == null || raw === '' ? String(def) : String(raw)).toLowerCase(),
                z.enum(BOOL_LITERALS, { error: `must be a boolean (${BOOL_LITERALS.join('/')})` }).transform((v) => TRUTHY.includes(v))
            )
            .describe(desc),
        meta: { type: 'boolean', default: def, desc },
    }
}

function enumString(def, allowed, desc) {
    return {
        schema: z
            .preprocess((raw) => (raw == null || raw === '' ? def : raw), z.enum(allowed, { error: `must be one of: ${allowed.join(', ')}` }))
            .describe(desc),
        meta: { type: 'string', default: def, allowed, desc },
    }
}

function string(def, desc, extraMeta = {}) {
    return {
        schema: z
            .preprocess((raw) => (raw == null || raw === '' ? def : raw), z.string({ error: 'must be a string' }))
            .describe(desc),
        meta: { type: 'string', default: def, desc, ...extraMeta },
    }
}

function optionalString(desc, extraMeta = {}) {
    return {
        schema: z
            .preprocess((raw) => (raw == null || raw === '' ? undefined : raw), z.string().optional())
            .describe(desc),
        meta: { type: 'string', default: null, desc, ...extraMeta },
    }
}

function stringList(def, desc, extraMeta = {}) {
    return {
        schema: z
            .preprocess(
                (raw) => (raw == null || raw === '' ? def : String(raw).split(',').map((s) => s.trim()).filter(Boolean)),
                z.array(z.string()).min(1, { error: 'must contain at least one non-empty, comma-separated entry' })
            )
            .describe(desc),
        meta: { type: 'comma-separated list', default: def, desc, ...extraMeta },
    }
}

// ---------------------------------------------------------------------------
// The schema. Defaults below MUST match the previously hardcoded fallbacks
// exactly (PORT 1610, DB_TYPE sqlite, ...); this module validates, it does
// not change behavior.
// ---------------------------------------------------------------------------

export const FIELDS = {
    // --- Essential ---
    PORT: int(1610, { min: 1, max: 65535 },
        'Port the server listens on (bound to 0.0.0.0). Local development tip: use 16100 to avoid clashing with a Docker container mapped to host port 1610.'),
    NODE_ENV: string('production',
        'Runtime mode. Only "development" changes behavior (verbose/dev helpers in a few modules); all other values including "production", "staging", "prod", etc. are treated identically.'),
    DATA_DIR: string(DEFAULT_DATA_DIR,
        'Directory for the SQLite database, the generated server_secret.key and traces. In Docker this must match the volume mount path (e.g. /app/data). Default: <server>/data',
        { defaultLabel: '<server>/data (Docker: /app/data)' }),
    MAX_SYNC_PAYLOAD_SIZE: int(104857600, { min: 1 },
        'Maximum size in bytes of the encrypted sync-state blob accepted by the sync API. Default: 100 MB (104857600).'),

    // --- Database ---
    DB_TYPE: enumString('sqlite', ['sqlite', 'postgres'],
        'Database engine: sqlite (zero-config, file-based) or postgres (recommended for scale / multi-tenant).'),
    DATABASE_URL: optionalString(
        'PostgreSQL connection string, e.g. postgres://user:password@host:5432/dbname. REQUIRED when DB_TYPE=postgres, ignored for sqlite. Leave unset for SQLite.'),
    DB_SSL_REJECT_UNAUTHORIZED: bool(false,
        'Verify the PostgreSQL server TLS certificate. Disabled by default because many providers use self-signed certificates; enable only with a trusted, pinned certificate path.'),
    DB_POOL_SIZE: int(20, { min: 1 },
        'Maximum number of PostgreSQL pool connections (ignored when DB_TYPE=sqlite).'),
    DB_CONNECTION_TIMEOUT: int(10000, { min: 1 },
        'Milliseconds to wait for a pool connection before timing out (PostgreSQL only).'),
    DB_MAX_RETRIES: int(5, { min: 1 },
        'Number of PostgreSQL connection attempts on startup with exponential backoff. The stored-settings read and the database connection each retry this many times, so a database that never comes up delays boot through two retry rounds.'),
    READ_ONLY_REPLICA: bool(false,
        'Run as a read-only standby against a replicated PostgreSQL database: skips schema/migrations and never starts the autopilot or activity workers, so the standby makes no background writes against your accounts. GET /api/health stays 200 while GET /api/ready returns 503, so point write-routing probes at /api/ready. Replicated rows are encrypted with the primary key: set ENCRYPTION_KEY (or copy server_secret.key) to the SAME value as the primary, otherwise the standby serves empty configs/addons. To take over: promote the replica (pg_promote) and restart with this unset.'),

    // --- Security ---
    ENCRYPTION_KEY: optionalString(
        'Encrypts sensitive data at rest (autopilot rules, Stremio auth keys, connection credentials). Zero-config: when empty, a secure random key is generated on first boot and saved to DATA_DIR/server_secret.key. Setting a value later keeps the old file key as a decrypt fallback so existing data stays readable.'),
    CORS_ORIGINS: stringList(['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173'],
        'Comma-separated allow-list of browser origins for the API, e.g. https://app.example.com,https://stremio.example.com. Empty = localhost-only development defaults.',
        { defaultLabel: 'localhost development origins (3000/5173/4173)' }),
    SSRF_ALLOW_PRIVATE: bool(false,
        'Allow the metadata proxy to fetch addon manifests from private/internal IP ranges (Docker networks, DNS rewrites, reverse proxies). Only enable on trusted self-hosted instances behind a firewall.'),
    TRUST_PROXY: bool(false,
        'Trust X-Forwarded-For headers from the reverse proxy (Traefik/nginx/NPM). Required behind a proxy for per-client rate limiting to see real client IPs; without it all proxied clients share one rate-limit bucket. WARNING: your proxy must OVERWRITE X-Forwarded-For with the real client IP ($remote_addr), not append to it. With append-style proxies this setting lets clients pick their own IP by sending a forged X-Forwarded-For header, which defeats rate limiting and forges logs.'),
    CUSTOM_HTML: optionalString(
        'Raw HTML injected at the top of the login/configuration page (hosted-instance banners, announcements).'),
    REGISTRATIONS_CLOSED: bool(false,
        'Block new account creation while existing users can still sign in.'),
    UNIFIED_ENFORCEMENT: bool(false,
        'Unify certain server-side enforcement checks across modules. Leave disabled for the default per-module behavior.'),

    // --- Dashboard (instance admin, opt-in) ---
    ADMIN_ENABLED: bool(false,
        'Turn on the instance Dashboard at /dashboard (API under /api/admin). Off by default: when off, no Dashboard route exists at all (404). The Dashboard manages the instance only; it can never read user contents, credentials or watch history. Sign-in lockouts are kept in memory, so restarting the server clears them. On a READ_ONLY_REPLICA the Dashboard refuses sign-in; use the primary.'),
    ADMIN_CREDENTIALS: optionalString(
        'Dashboard sign-in as username:password. Choose your own username (1 to 64 characters) and nonempty password (up to 1024 characters, no minimum length or complexity rule); quote the full value in .env. Split on the first colon, so the password may contain colons and spaces. The server hashes the password internally. Takes precedence over ADMIN_SECRET_HASH, ADMIN_USERNAME and browser setup. Invalid credentials keep the Dashboard off; they never enable setup or fall back to stored credentials. Change this value and restart to change the sign-in.',
        { example: '"Sonic:SonicsPassword"' }),
    ADMIN_SECRET_HASH: optionalString(
        'Alternative Dashboard password as a scrypt hash (never the plaintext). Generate it with: npm --prefix server run admin:hash. Used when ADMIN_CREDENTIALS is empty; takes precedence over a username and password chosen through ADMIN_SETUP. An invalid value keeps the Dashboard off with a log line.'),
    ADMIN_USERNAME: optionalString(
        'Dashboard sign-in username that goes with ADMIN_SECRET_HASH. Compared trimmed and case-insensitively. Defaults to admin when ADMIN_SECRET_HASH is set without it.'),
    ADMIN_SETUP: enumString('off', ['off', 'token'],
        'Set to token to choose the Dashboard username and password in the browser instead of ADMIN_SECRET_HASH: while none exists, boot prints a single-use Dashboard setup token to stdout (valid 15 minutes). Restart with token again to issue a new one.'),
    ADMIN_ALLOW_IPS: optionalString(
        'Optional comma-separated IPs or CIDR ranges allowed to reach the Dashboard, e.g. 192.168.1.0/24,10.0.0.5. Others get a plain 404 before any password check. Empty allows every address.'),
    ADMIN_ALLOW_HTTP_LAN: bool(false,
        'Allow Dashboard sign-in over plain HTTP, but only from loopback or private network addresses (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7, fe80::/10, resolved through TRUST_PROXY_HOPS). Public addresses over HTTP stay refused. WARNING: without HTTPS the Dashboard password and session cookie cross your network unencrypted, so anyone on that network can capture them. The cookie keeps HttpOnly and SameSite=Strict but loses Secure. Prefer HTTPS; enable this only on a network you trust.'),
    TRUST_PROXY_HOPS: int(0, { min: 0, max: 10 },
        'Number of reverse proxies in front of the server. The Dashboard reads the client IP from the X-Forwarded-For entry this many hops from the right, and trusts X-Forwarded-Proto/Host, only when the connection comes from a trusted proxy (loopback, private ranges, or TRUSTED_PROXY_CIDRS) and the chain is at least this long. 0 uses the socket peer. The backend port must only be reachable through the proxy: publish the proxy, not the server port. Behind a proxy on the same host that sends no forwarding headers, every client looks like loopback and they all share the loopback bucket, so one attacker locks out everyone and the known-device cookie does not help; configure the proxy to send X-Forwarded-For.'),
    TRUSTED_PROXY_CIDRS: optionalString(
        'Optional comma-separated IPs or CIDR ranges of your reverse proxies, e.g. 172.18.0.0/16. When set, only these (plus loopback) may supply X-Forwarded-* headers to the Dashboard; when empty, loopback and private ranges are trusted. Only used with TRUST_PROXY_HOPS.'),

    // --- Logging ---
    LOG_LEVEL: enumString('info', ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
        'Server log verbosity: fatal, error, warn, info, debug or trace.'),
    LOG_PRETTY_PRINT: bool(true,
        'Pretty-print logs for humans (true) or emit JSON lines for log shippers (false). Recommended: false in production.'),

    // --- Proxy & image caching ---
    PROXY_CONCURRENCY_LIMIT: int(50, { min: 1 },
        'Maximum concurrent outbound proxy/metadata requests the server fans out.'),
    AIOSTREAMS_USER_API_THROTTLE_MS: int(1000, { min: 200, clampBelowMin: true },
        'Minimum interval in ms between calls to a single AIOStreams user API endpoint.'),
    IMAGE_PROXY_TIMEOUT_MS: int(4000, { min: 1000, clampBelowMin: true },
        'Per-request timeout in ms for the poster/image proxy. Lower fails fast so the shared queue drains instead of clogging on a slow image source.'),
    IMAGE_PROXY_QUEUE_LIMIT: int(300, { min: 30, clampBelowMin: true },
        'Max queued plus in-flight image-proxy requests; isolates poster storms from the stream/manifest proxies sharing the global queue. Requests past it fail at once, so it must cover several users opening poster pages together. Capped at 60% of the shared queue (300) so posters always leave room for other proxy traffic.'),
    IMAGE_PROXY_THROTTLE_MS: int(5, { min: 0, clampBelowMin: true },
        'Minimum interval in ms between image-proxy calls to a single host. MetaHub is a CDN, so this stays far below the global throttle. 0 disables.'),
    IMAGE_CACHE_TTL_MS: int(86400000, { min: 0, clampBelowMin: true },
        'TTL in ms for the shared in-memory poster cache: hot posters serve from memory and identical cold requests collapse into one upstream fetch. 0 disables.'),
    IMAGE_CACHE_MAX_BYTES: int(134217728, { min: 0, clampBelowMin: true },
        'Total byte budget for the in-memory poster cache (bounded by bytes, not entry count). Default: 128 MB. 0 disables the cache.'),
    IMAGE_CACHE_MAX_ITEM_BYTES: int(524288, { min: 0, clampBelowMin: true },
        'Reject single cache entries larger than this many bytes. Default: 512 KB. 0 disables the limit.'),
    DATASTORE_META_BATCH_MAX: int(50, { min: 1, clampBelowMin: true },
        'Maximum accounts per DatastoreMetaBatch request (the batched library mtime pre-check). Bounded so one request cannot fan out unbounded upstream fetches.'),
    DATASTORE_META_BATCH_CONCURRENCY: int(8, { min: 1, clampBelowMin: true },
        'Upstream fan-out concurrency inside one DatastoreMetaBatch request.'),
    DATASTORE_META_BATCH_ENTRY_TIMEOUT_MS: int(8000, { min: 1000, clampBelowMin: true },
        'Per-entry upstream timeout for DatastoreMetaBatch; a dead platform fails its slot fast instead of stalling the batch. Failed entries return null and the client falls back to that account\'s full path.'),

    // --- Activity engine (opt-in) ---
    ACTIVITY_ENGINE_ENABLED: bool(false,
        'Opt in to server-side background polling that captures watch activity (events + snapshots) on a timer, so Activity/Replay history builds even with no client open. Multi-tenant warning: every account is polled each cycle (the write-amplification pattern behind the Midnight incident), so enable it only on single-user/trusted instances. Client-side Activity tracking works without this.'),
    ACTIVITY_SCAN_INTERVAL_MS: int(300000, { min: 60000, clampBelowMin: true },
        'Base delay in ms between activity scans.'),
    ACTIVITY_SCAN_JITTER_MS: int(120000, { min: 0, clampBelowMin: true },
        'Random extra delay in ms (0..value) spread over accounts to avoid a thundering herd.'),
    ACTIVITY_INITIAL_DELAY_MS: int(30000, { min: 5000, clampBelowMin: true },
        'Delay in ms before the first scan after boot.'),
    ACTIVITY_CYCLE_BUDGET_MS: int(120000, { min: 10000, clampBelowMin: true },
        'Wall-clock budget in ms per scan cycle.'),
    ACTIVITY_MAX_ACCOUNTS_PER_CYCLE: int(50, { min: 1, clampBelowMin: true },
        'Hard cap on accounts scanned per cycle.'),
    ACTIVITY_MAX_EVENTS_PER_CYCLE: int(1000, { min: 1, clampBelowMin: true },
        'Hard cap on activity events written per cycle.'),
    ACTIVITY_MAX_SNAPSHOT_WRITES_PER_CYCLE: int(5000, { min: 1, clampBelowMin: true },
        'Hard cap on snapshot rows written per cycle.'),
    ACTIVITY_BATCH_SIZE: int(40, { min: 1, clampBelowMin: true },
        'Events accumulated before a batched database write.'),
    ACTIVITY_FETCH_TIMEOUT_MS: int(10000, { min: 1000, clampBelowMin: true },
        'Per-account fetch timeout in ms.'),
    ACTIVITY_HASH_CACHE_TTL_MS: int(86400000, { min: 60000, clampBelowMin: true },
        'TTL in ms for the per-account state-hash cache.'),
    ACTIVITY_HASH_CACHE_MAX: int(5000, { min: 100, clampBelowMin: true },
        'Maximum number of accounts tracked in the state-hash cache.'),
    ACTIVITY_SCAN_CONCURRENCY: int(4, { min: 1, clampBelowMin: true },
        'Maximum accounts scanned in parallel per activity cycle. Write reservations preserve the cycle event and snapshot caps.'),
    ACTIVITY_BREAKER_THRESHOLD: int(2, { min: 1, clampBelowMin: true },
        'Consecutive fetch failures before an account enters breaker backoff. 1 trips on the first failure.'),
    ACTIVITY_BREAKER_BASE_MS: int(300000, { min: 0, clampBelowMin: true },
        'First breaker backoff window in ms for an account whose library fetch keeps failing. 0 disables the breaker.'),
    ACTIVITY_BREAKER_MAX_MS: int(3600000, { min: 0, clampBelowMin: true },
        'Ceiling in ms for the exponential breaker backoff (doubles per additional consecutive failure).'),

    // --- Autopilot engine ---
    AUTOPILOT_SCAN_CHUNK_SIZE: int(500, { min: 100, clampBelowMin: true },
        'Maximum rules scanned per autopilot cycle.'),
    AUTOPILOT_MAX_RULES_PER_CYCLE: int(10000, { min: 100, clampBelowMin: true },
        'Hard cap on rules processed in a single cycle. Autopilot only writes tiny timestamp updates, so large values are safe. Effectively max(scan chunk size, this value).'),
    AUTOPILOT_CYCLE_BUDGET_MS: int(120000, { min: 5000, clampBelowMin: true },
        'Wall-clock budget in ms per autopilot cycle. With 1000+ rules, 120s gives ample time for health checks.'),
    AUTOPILOT_HEALTH_CACHE_TTL_MS: int(30000, { min: 10000, clampBelowMin: true },
        'How long addon health-check results are cached, in ms.'),
    AUTOPILOT_RULE_CONCURRENCY: int(32, { min: 1 },
        'Accounts the autopilot worker checks in parallel. Each finishes on its own, so one slow addon never holds up the rest.'),
    AUTOPILOT_MANIFEST_PROBES_PER_HOST: int(6, { min: 1 },
        'Maximum manifest health checks in flight to one addon host. Public hosts serve a unique manifest per user, so this bounds the load one instance puts on them.'),
    AUTOPILOT_HEALTH_TARGETS_MAX: int(20000, { min: 100, clampBelowMin: true },
        'Most health targets (app instances) Autopilot keeps state for in memory. Targets no rule referenced for 30 minutes go first, then the least recently referenced.'),
    AUTOPILOT_RULE_RECHECK_MS: int(30000, { min: 10000, clampBelowMin: true },
        'Minimum interval in ms before a rule is re-evaluated.'),
    AUTOPILOT_RULE_CACHE_MAX_BYTES: int(268435456, { min: 0, clampBelowMin: true },
        'Byte budget for caching rules stable columns (addon_list/priority_chain) in memory so the worker stops re-reading them every cycle, a big win on remote databases (e.g. Supabase). Default: 256 MB. 0 disables.'),
    AUTOPILOT_RULE_CACHE_TTL_MS: int(86400000, { min: 60000, clampBelowMin: true },
        'Safety-net TTL in ms for the rule cache. Invalidation is event-driven (writes bump updated_at); this only caps how long an idle entry stays in memory. Default: 24 hours.'),
    AUTOPILOT_WRITE_TRIPWIRE: bool(true,
        'Last-resort Autopilot write tripwire. Counts every engine-driven write (cycles, failover commits, stats, history) to autopilot_rules, autopilot_rule_stats and failover_history over a rolling 60 minutes. User rule saves and the echo they trigger never count here; they use the per-owner budget below. Above the limits below Autopilot enters safe mode: no DB writes, Stremio/Nuvio/RealStream pushes, swaps or webhooks, so every user keeps their current addons. Safe mode is in memory only and lasts until the process restarts (fix the cause, then restart). /api/health shows autopilot.safeMode while it holds. false disables the tripwire and the per-owner budget.'),
    AUTOPILOT_WRITE_TRIPWIRE_PER_HOUR: int(0, { min: 0 },
        'Write statements per rolling hour that trip the tripwire. 0 derives max(600, active rules x 20), where active rules are those the engine checked in the last hour. Expected v1 load: 0 rule writes per steady cycle, heartbeat stats batched 100 rows per statement, and about 3 statements per failover or recovery (measured: 500 rules failing over in one cycle and recovering wrote 6.03 per rule). 20 per rule leaves room for every rule to fail over and recover three times in the same hour. The scheduler checks a rule at most once per 60s cycle, so a loop that rewrites a rule every cycle (60 per rule per hour) trips within about 20 minutes, and a tight loop within seconds.'),
    AUTOPILOT_WRITE_TRIPWIRE_BYTES_PER_HOUR: int(0, { min: 0 },
        'Parameter bytes written per rolling hour that trip the tripwire. 0 derives max(50 MB, active rules x 1 MB). A typical encrypted addon_list is about 66 KB (measured: the 500-rule outage and recovery wrote 66 MB, which a flat 50 MB cap would have tripped), so 1 MB per rule allows about 15 full rewrites per rule per hour. A loop rewriting addon_list on every rule each cycle trips in about 15 minutes even at a low statement count.'),
    AUTOPILOT_OWNER_WRITES_PER_HOUR: int(300, { min: 1 },
        'Per-owner rolling-hour budget of Autopilot table writes from that owner\'s own rule saves and the immediate enforcement each save triggers. Above it only that owner gets HTTP 429 ("Too many Autopilot changes, try again in N minutes") until the window rolls; other users and the engine are unaffected. A save costs 1 to 2 statements, so 300 covers re-saving a 100-rule account plus its echoes with room to spare. In memory only, up to 10000 owners (least recently active dropped first, idle owners pruned after an hour).'),
    AUTOPILOT_OWNER_ADDON_LIST_BYTES_PER_HOUR: int(33554432, { min: 1 },
        'Per-owner rolling-hour cap on addon_list bytes written by that owner\'s rule saves and their echo. Default 32 MB, about 500 rewrites of a typical 66 KB encrypted collection. Exceeding it returns the same per-owner 429.'),
    AUTOPILOT_TRIPWIRE_WEBHOOK_URL: optionalString(
        'Optional hoster alert: when the write tripwire trips, one short JSON message (Discord content / Slack text compatible, no user data) is POSTed here through the SSRF-guarded fetch. Sent once per process.'),

    // --- Internal / debug ---
    SQLITE_DB_PATH: optionalString(
        'INTERNAL: set programmatically by database/setup.js at boot (defaults to DATA_DIR/aio.db). Do not set manually.'),
    AIOMAN_TRACE: bool(false,
        'INTERNAL: request tracing to DATA_DIR/trace.log for debugging. Accepts 1/true/yes/on.'),
}

// Logical grouping used when generating .env.example (presentation only).
export const ENV_GROUPS = [
    { title: 'ESSENTIAL SETUP', vars: ['PORT', 'NODE_ENV', 'DATA_DIR', 'MAX_SYNC_PAYLOAD_SIZE'] },
    { title: 'DATABASE', note: 'Pool settings are ignored when DB_TYPE=sqlite.', vars: ['DB_TYPE', 'DATABASE_URL', 'DB_SSL_REJECT_UNAUTHORIZED', 'DB_POOL_SIZE', 'DB_CONNECTION_TIMEOUT', 'DB_MAX_RETRIES', 'READ_ONLY_REPLICA'] },
    { title: 'SECURITY', vars: ['ENCRYPTION_KEY', 'CORS_ORIGINS', 'SSRF_ALLOW_PRIVATE', 'TRUST_PROXY', 'CUSTOM_HTML', 'REGISTRATIONS_CLOSED', 'UNIFIED_ENFORCEMENT'] },
    { title: 'DASHBOARD (OPT-IN)', note: 'Instance Dashboard for self-hosters. Off unless ADMIN_ENABLED=true.', vars: ['ADMIN_ENABLED', 'ADMIN_CREDENTIALS', 'ADMIN_SECRET_HASH', 'ADMIN_USERNAME', 'ADMIN_SETUP', 'ADMIN_ALLOW_IPS', 'ADMIN_ALLOW_HTTP_LAN', 'TRUST_PROXY_HOPS', 'TRUSTED_PROXY_CIDRS'] },
    { title: 'LOGGING', vars: ['LOG_LEVEL', 'LOG_PRETTY_PRINT'] },
    { title: 'PROXY & IMAGE CACHING', vars: ['PROXY_CONCURRENCY_LIMIT', 'AIOSTREAMS_USER_API_THROTTLE_MS', 'IMAGE_PROXY_TIMEOUT_MS', 'IMAGE_PROXY_QUEUE_LIMIT', 'IMAGE_PROXY_THROTTLE_MS', 'IMAGE_CACHE_TTL_MS', 'IMAGE_CACHE_MAX_BYTES', 'IMAGE_CACHE_MAX_ITEM_BYTES', 'DATASTORE_META_BATCH_MAX', 'DATASTORE_META_BATCH_CONCURRENCY', 'DATASTORE_META_BATCH_ENTRY_TIMEOUT_MS'] },
    { title: 'ACTIVITY ENGINE (OPT-IN)', note: 'Safe defaults shown. Only relevant when you explicitly opt into server-side activity capture via ACTIVITY_ENGINE_ENABLED. Events are kept permanently so Activity can behave like Replay.', vars: ['ACTIVITY_ENGINE_ENABLED', 'ACTIVITY_SCAN_INTERVAL_MS', 'ACTIVITY_SCAN_JITTER_MS', 'ACTIVITY_INITIAL_DELAY_MS', 'ACTIVITY_CYCLE_BUDGET_MS', 'ACTIVITY_MAX_ACCOUNTS_PER_CYCLE', 'ACTIVITY_MAX_EVENTS_PER_CYCLE', 'ACTIVITY_MAX_SNAPSHOT_WRITES_PER_CYCLE', 'ACTIVITY_BATCH_SIZE', 'ACTIVITY_FETCH_TIMEOUT_MS', 'ACTIVITY_HASH_CACHE_TTL_MS', 'ACTIVITY_HASH_CACHE_MAX', 'ACTIVITY_SCAN_CONCURRENCY', 'ACTIVITY_BREAKER_THRESHOLD', 'ACTIVITY_BREAKER_BASE_MS', 'ACTIVITY_BREAKER_MAX_MS'] },
    { title: 'AUTOPILOT ENGINE', vars: ['AUTOPILOT_SCAN_CHUNK_SIZE', 'AUTOPILOT_MAX_RULES_PER_CYCLE', 'AUTOPILOT_CYCLE_BUDGET_MS', 'AUTOPILOT_HEALTH_CACHE_TTL_MS', 'AUTOPILOT_MANIFEST_PROBES_PER_HOST', 'AUTOPILOT_HEALTH_TARGETS_MAX', 'AUTOPILOT_RULE_CONCURRENCY', 'AUTOPILOT_RULE_RECHECK_MS', 'AUTOPILOT_RULE_CACHE_MAX_BYTES', 'AUTOPILOT_RULE_CACHE_TTL_MS', 'AUTOPILOT_WRITE_TRIPWIRE', 'AUTOPILOT_WRITE_TRIPWIRE_PER_HOUR', 'AUTOPILOT_WRITE_TRIPWIRE_BYTES_PER_HOUR', 'AUTOPILOT_OWNER_WRITES_PER_HOUR', 'AUTOPILOT_OWNER_ADDON_LIST_BYTES_PER_HOUR', 'AUTOPILOT_TRIPWIRE_WEBHOOK_URL'] },
    { title: 'INTERNAL / DEBUG', note: 'Do not set these manually.', vars: ['SQLITE_DB_PATH', 'AIOMAN_TRACE'] },
]

export const serverSchema = Object.fromEntries(Object.entries(FIELDS).map(([name, field]) => [name, field.schema]))

// Cross-field topology rules the per-field schema cannot express. Checked once at
// boot in lib/env.js, with the same fatal treatment as a field-level parse failure.
export function envTopologyProblems(values) {
    if (values.READ_ONLY_REPLICA && values.DB_TYPE === 'sqlite') {
        return [
            'READ_ONLY_REPLICA requires DB_TYPE=postgres: a SQLite replica is not a supported topology (the SQLite file stays writable, so the standby would keep writing).',
        ]
    }
    return []
}
export const ENV_META = Object.fromEntries(Object.entries(FIELDS).map(([name, field]) => [name, field.meta]))
