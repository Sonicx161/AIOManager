import crypto from 'crypto'
import db from '../db.js'
import { PRIMARY_KEY } from '../keys.js'
import { proxyQueue, proxyQueueKeyCounts, serverState } from '../state.js'
import { metadataCache } from '../lib/metadata-cache.js'
import { ADMIN_LIMITS, isAdminEnabled, adminSetupMode, adminCredentialsEnv, adminSecretHashEnv, adminUsernameEnv, adminReadOnly, trustProxyHops, adminAllowHttpLan, adminAllowIps, trustedProxyCidrs } from '../admin/config.js'
import { adminHashProblem, verifyAdminLogin, hashAdminPassphrase, passphraseProblem, usernameProblem, normalizeAdminUsername, parseAdminCredentials, LEGACY_ADMIN_USERNAME } from '../admin/passphrase.js'
import { adminClientIp, isDirectLoopback, limiterKey, forwardedInfo, forwardedHost, isAllowedIp, isLoopback, isPrivateOrLoopback, isSecureRequest, ipPrefix, uaHash, uaFamily, allowlistProblems } from '../admin/net.js'
import { createLoginLimiter } from '../admin/limiter.js'
import { createSessionStore, sessionHandle, hashSessionId } from '../admin/sessions.js'
import { appendAudit, listAudit, verifyAuditChain } from '../admin/audit.js'
import { DEVICE_COOKIE, issueDeviceToken, verifyDeviceToken, verifyRememberedDeviceToken, deviceCookieHeader } from '../admin/known-device.js'
import { createReads, createSystemSampler } from '../admin/reads.js'
import { createHostMetricsSampler } from '../lib/host-metrics.js'
import { createSettings, SettingsError } from '../admin/settings.js'
import { createAccountActions, createBulkDelete } from '../admin/account-actions.js'
import { createRepairs } from '../admin/repairs.js'
import { readLogs, logsPage, logsForExport, toWireLine, subscribeLogs, logListenerCount, MAX_LOG_VIEWERS } from '../admin/log-ring.js'

const SECURE_COOKIE = '__Host-aiom_admin'
const PLAIN_COOKIE = 'aiom_admin'
const INVALID = { error: 'Invalid credentials' }
const LOGIN_INCORRECT = { error: 'Username or password is incorrect.' }
const UNAUTHORIZED = { error: 'Unauthorized' }
const SSE_HEARTBEAT_MS = 25_000
const SSE_RECHECK_MS = 60_000
const ORIGIN_MISMATCH = 'Origin not allowed: the host in the browser Origin does not match the Host header this server received. Behind a reverse proxy, forward the original host (nginx: proxy_set_header Host $host;), or send X-Forwarded-Host from a trusted proxy with TRUST_PROXY_HOPS set.'
// Settings writes carry up to 8192 characters of custom HTML, which in non-ASCII text is about 32 KB.
const SETTINGS_BODY_LIMIT = 64 * 1024
const USERS_FAIL_TTL_MS = 30_000
const USERS_UNAVAILABLE = { error: 'Account data is temporarily unavailable (the read failed or timed out). Try again shortly.' }
const AUDIT_RETENTION_NOTE = 'Append-only and hash-chained. The Dashboard cannot edit or clear it; the verifier reports a broken chain instead of hiding it.'

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest()
const safeEqual = (a, b) => {
    const x = Buffer.from(String(a ?? ''))
    const y = Buffer.from(String(b ?? ''))
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y)
}

function readCookies(request) {
    const out = new Map()
    for (const part of String(request.headers.cookie || '').split(';')) {
        const i = part.indexOf('=')
        if (i > 0 && !out.has(part.slice(0, i).trim())) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
    }
    return out
}

export function readAdminCookie(request) {
    const jar = readCookies(request)
    return jar.get(SECURE_COOKIE) ?? jar.get(PLAIN_COOKIE) ?? null
}


const cookieHeader = (secure, value, maxAgeSec) => secure
    ? `${SECURE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`
    : `${PLAIN_COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`

// Sign-out clears the session cookies only; revoke-all also expires the known-device cookie.
const clearCookies = (reply, { device = false } = {}) => reply.header('Set-Cookie', [
    cookieHeader(true, '', 0),
    cookieHeader(false, '', 0),
    ...(device ? [`${DEVICE_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0`] : []),
])

function originMatches(request) {
    const origin = request.headers.origin
    if (!origin || origin === 'null') return false
    let parsed
    try { parsed = new URL(origin) } catch { return false }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const defaultPort = parsed.protocol === 'https:' ? ':443' : ':80'
    const norm = (h) => { const v = String(h || '').trim().toLowerCase(); return v.endsWith(defaultPort) ? v.slice(0, -defaultPort.length) : v }
    const hosts = [norm(request.headers.host)]
    const fwd = forwardedHost(request)
    if (fwd) hosts.push(norm(fwd))
    return hosts.includes(norm(parsed.host))
}

// A viewer that stops reading is closed once about 1 MB is buffered for it, so a stalled
// tab cannot grow server memory.
const SSE_MAX_BUFFERED = 1024 * 1024
export function sseWrite(raw, entry, close) {
    if (raw.writableLength > SSE_MAX_BUFFERED) { close(); return }
    raw.write(`id: ${entry.seq}\ndata: ${JSON.stringify(toWireLine(entry))}\n\n`)
}

// Registers nothing unless ADMIN_ENABLED, so every /api/admin path is a plain 404.
export async function registerAdminRoutes(fastify, { limits = ADMIN_LIMITS, log = fastify.log, autopilotEngine = null, activityEngine = null, reconciler = null, sampler = null, hostSampler = null, settingsBoot = undefined } = {}) {
    if (!isAdminEnabled()) return { enabled: false }

    const envCredentials = adminCredentialsEnv()
    let envHash = envCredentials ? null : adminSecretHashEnv()
    let envUser = null
    if (envCredentials) {
        const parsed = parseAdminCredentials(envCredentials)
        if (!parsed) {
            log.error({ category: 'Dashboard' }, 'ADMIN_CREDENTIALS must use username:password with a username of 1 to 64 characters and a nonempty password of at most 1024 characters. The Dashboard stays off until this is fixed.')
            return { enabled: false, reason: 'invalid-admin-credentials' }
        }
        envUser = parsed.username
        // Instance-specific salt keeps known-device cookies valid across restarts with
        // the same credentials; changing either field still retires those cookies.
        const salt = crypto.createHmac('sha256', PRIMARY_KEY).update(`aiom-dashboard-env|${envUser}`).digest().subarray(0, 16)
        envHash = await hashAdminPassphrase(parsed.password, { salt })
    }
    const envProblem = envHash ? adminHashProblem(envHash) : null
    if (envProblem === 'memory') {
        log.error({ category: 'Dashboard' }, 'ADMIN_SECRET_HASH asks scrypt for more than 256 MiB of memory (128 * N * r). Generate a new hash with: npm --prefix server run admin:hash. The Dashboard stays off until this is fixed.')
        return { enabled: false, reason: 'secret-hash-too-costly' }
    }
    if (envProblem) {
        log.error({ category: 'Dashboard' }, 'ADMIN_SECRET_HASH is not a valid hash (a plaintext passphrase is never accepted). Generate one with: npm --prefix server run admin:hash. The Dashboard stays off until this is fixed.')
        return { enabled: false, reason: 'invalid-secret-hash' }
    }
    if (!envCredentials && envHash && adminUsernameEnv() && usernameProblem(adminUsernameEnv())) {
        log.error({ category: 'Dashboard' }, 'ADMIN_USERNAME is not a usable username (1 to 64 characters, no control characters). The Dashboard stays off until this is fixed.')
        return { enabled: false, reason: 'invalid-username' }
    }
    const badAllow = allowlistProblems()
    if (badAllow.length) log.warn({ category: 'Dashboard' }, `ADMIN_ALLOW_IPS has ${badAllow.length} unparseable entr${badAllow.length === 1 ? 'y' : 'ies'}; they match nothing.`)
    if (['1', 'true', 'yes', 'on'].includes(String(process.env.TRUST_PROXY || '').toLowerCase()) && !trustProxyHops()) {
        log.warn({ category: 'Dashboard' }, 'Dashboard: TRUST_PROXY is on but TRUST_PROXY_HOPS is 0, so the Dashboard sees the proxy as the client and refuses sign-in when forwarded headers arrive. Set TRUST_PROXY_HOPS to the number of proxies in front of the server.')
    }
    if (trustProxyHops() && !trustedProxyCidrs().length) {
        log.warn({ category: 'Dashboard' }, 'Dashboard: TRUST_PROXY_HOPS is set without TRUSTED_PROXY_CIDRS, so any loopback or private-range host can act as a proxy and set X-Forwarded-For. Set TRUSTED_PROXY_CIDRS to the proxy addresses.')
    }

    let storedHash = envHash
    let storedUser = envUser || (envHash ? normalizeAdminUsername(adminUsernameEnv() || LEGACY_ADMIN_USERNAME) : null)
    if (!storedHash) {
        try {
            const row = await db.get('SELECT username, secret_hash FROM admin_credentials WHERE id = $1', ['primary'])
            const rowProblem = row ? adminHashProblem(row.secret_hash) : null
            if (rowProblem) {
                log.error({ category: 'Dashboard' }, `The stored Dashboard credential (admin_credentials) ${rowProblem === 'memory' ? 'asks scrypt for more than 256 MiB of memory' : 'cannot be parsed'}. Set ADMIN_SECRET_HASH, or delete that row and start with ADMIN_SETUP=token to choose a new username and password. The Dashboard stays off until this is fixed.`)
                return { enabled: false, reason: 'invalid-stored-credential' }
            }
            if (row) {
                storedHash = row.secret_hash
                storedUser = normalizeAdminUsername(row.username || LEGACY_ADMIN_USERNAME)
            }
        } catch (err) {
            log.warn({ category: 'Dashboard' }, `Could not read the Dashboard credential: ${err.message}`)
        }
    }

    // Sign-in locks live in memory only; a restart clears them.
    const limiter = createLoginLimiter({ limits })
    const hostMetrics = hostSampler || createHostMetricsSampler()
    fastify.addHook('onClose', async () => { limiter.stop(); hostMetrics.stop() })
    // Instance-level hook: counts every route, integer increments only.
    fastify.addHook('onResponse', async (_request, reply) => { hostMetrics.countResponse(reply.statusCode) })

    const sessions = createSessionStore({ limits })
    const systemSampler = sampler || createSystemSampler()
    const reads = createReads({ autopilotEngine, activityEngine, limiter, sessions, sampler: systemSampler, hostSampler: hostMetrics })
    const settings = createSettings({ log, logger: fastify.log, actor: () => storedUser, ...(settingsBoot ? { boot: settingsBoot } : {}) })

    let setupToken = null
    if (!storedHash && adminSetupMode() === 'token' && !adminReadOnly()) {
        const token = crypto.randomBytes(32).toString('base64url')
        setupToken = { hash: sha256(token), expiresAt: Date.now() + limits.setupTokenTtlMs }
        // stdout only, once: never the logger, ring buffer or trace file.
        process.stdout.write(`\n[Dashboard] Dashboard setup token (single use, valid 15 minutes): ${token}\n[Dashboard] Open /dashboard and enter it to choose the Dashboard username and password. Restart with ADMIN_SETUP=token to issue a new one.\n\n`)
    } else if (!storedHash) {
        log.warn({ category: 'Dashboard' }, 'ADMIN_ENABLED is on but no Dashboard sign-in is configured. Set ADMIN_CREDENTIALS=username:password, use ADMIN_SECRET_HASH with ADMIN_USERNAME, or start once with ADMIN_SETUP=token.')
    }
    // Device cookies are keyed to the credential, so a new username or password retires them.
    const deviceCredential = () => storedHash ? `${storedUser}|${storedHash}` : null
    const setupPending = () => Boolean(setupToken && !storedHash && setupToken.expiresAt > Date.now())

    const auditCtx = (request) => ({ ipPrefix: ipPrefix(request.adminIp), uaHash: uaHash(request.headers['user-agent']), uaFamily: uaFamily(request.headers['user-agent']) })
    const auditBestEffort = (request, entry) => appendAudit({ ...auditCtx(request), ...entry })
        .catch((err) => log.warn({ category: 'Dashboard' }, `Audit write failed for ${entry.event}: ${err.message}`))

    // A proxy on the same host with TRUST_PROXY_HOPS=0 would make every client look like
    // loopback; refuse sign-in and say how to fix it, logging the hint once.
    let warnedHopsZero = false
    function proxyMisconfig(request) {
        if (trustProxyHops() || !forwardedInfo(request).present) return null
        if (!warnedHopsZero) {
            warnedHopsZero = true
            log.warn({ category: 'Dashboard' }, 'Dashboard sign-in refused: X-Forwarded-* headers arrived but TRUST_PROXY_HOPS is 0. Set TRUST_PROXY_HOPS to the number of proxies in front of the server.')
        }
        return 'This request came through a proxy (X-Forwarded-* headers are present) but TRUST_PROXY_HOPS is 0. Set TRUST_PROXY_HOPS to the number of proxies in front of the server, then sign in again.'
    }

    function transportProblem(request) {
        if (isSecureRequest(request)) return null
        const ip = adminClientIp(request)
        if (isDirectLoopback(request)) return null
        // Opt-in plain HTTP for home networks: private clients only, never public, and
        // loopback only when it is the direct peer.
        if (adminAllowHttpLan() && isPrivateOrLoopback(ip) && !isLoopback(ip)) return null
        return 'The Dashboard only signs in over HTTPS. Serve the instance over HTTPS (or set TRUST_PROXY_HOPS behind a TLS proxy), or set ADMIN_ALLOW_HTTP_LAN=true to allow plain HTTP from private network addresses, and try again.'
    }

    async function issueSession(request, reply, { remember = false } = {}) {
        const secure = isSecureRequest(request)
        const created = await sessions.create({ ipPrefix: ipPrefix(request.adminIp), uaHash: uaHash(request.headers['user-agent']), uaFamily: uaFamily(request.headers['user-agent']), remembered: remember })
        // A remembered browser holds its session as a 30-day persistent cookie; every other
        // sign-in keeps the short-lived cookie. Same HttpOnly/Secure/SameSite either way.
        const lifetimeMs = remember ? limits.rememberedSessionAbsoluteMs : limits.sessionAbsoluteMs
        reply.header('Set-Cookie', [cookieHeader(secure, created.id, Math.floor(lifetimeMs / 1000)), deviceCookieHeader(secure, issueDeviceToken(deviceCredential(), { remembered: remember }))])
        return { csrf: created.csrf, expiresAt: created.expiresAt, idleExpiresAt: created.idleExpiresAt }
    }

    // Charges the limiter, runs exactly one check, settles, and audits lock transitions.
    // One KDF at a time instance-wide: a sign-in arriving while another is hashing gets 429
    // before it costs anything, except one privileged waiter (known device, direct loopback
    // or a direct allowlisted peer) that waits a short while for the slot.
    const KDF_WAIT_MS = 5000
    let kdfCurrent = null
    let kdfWaiter = false
    const busyBody = { error: 'The Dashboard is busy checking another sign-in. Try again in a moment.' }
    const refuseBusy = (reply) => {
        reply.header('Retry-After', '1')
        reply.status(429)
        return busyBody
    }
    async function withKdf(fn) {
        const run = Promise.resolve().then(fn)
        kdfCurrent = run.catch(() => {})
        try { return await run } finally { kdfCurrent = null }
    }
    async function waitForKdf(privileged) {
        if (!kdfCurrent) return true
        if (!privileged || kdfWaiter) return false
        kdfWaiter = true
        let timer
        try {
            await Promise.race([kdfCurrent, new Promise((r) => { timer = setTimeout(r, KDF_WAIT_MS) })])
        } finally {
            clearTimeout(timer)
            kdfWaiter = false
        }
        return !kdfCurrent
    }
    const privilegedPeer = (request) => {
        const direct = !forwardedInfo(request).trusted
        return isDirectLoopback(request) || (direct && adminAllowIps().length > 0 && isAllowedIp(request.adminIp))
    }

    async function attempt(request, reply, check) {
        const key = limiterKey(request.adminIp)
        const knownDevice = verifyDeviceToken(readCookies(request).get(DEVICE_COOKIE), deviceCredential())
        const opts = { exemptGlobal: knownDevice || privilegedPeer(request), prefix: ipPrefix(request.adminIp) }
        let gate
        try {
            gate = limiter.check(key, Date.now(), opts)
            if (gate.allowed && kdfCurrent && !(await waitForKdf(knownDevice || privilegedPeer(request)))) return { ok: false, body: refuseBusy(reply) }
            if (gate.allowed) gate = limiter.charge(key, Date.now(), opts)
        } catch {
            gate = { allowed: false, retryAfterMs: 60000 }
        }
        if (!gate.allowed) {
            reply.header('Retry-After', String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))))
            reply.status(429)
            return { ok: false, body: { error: 'Too many attempts. Try again later.' } }
        }
        let ok = false
        try { ok = await withKdf(check) } catch { ok = false }
        for (const t of limiter.settle(gate.charge, ok)) {
            auditBestEffort(request, { event: t.event, result: 'locked', details: { until: t.lockedUntil, scope: t.scope } })
        }
        return { ok }
    }

    const adminKey = (req) => `admin:${limiterKey(adminClientIp(req))}`
    const opts = ({ max = 120, ...config } = {}) => ({
        bodyLimit: limits.bodyLimit,
        schema: { hide: true },
        config: { ...config, cors: false, rateLimit: { max, timeWindow: '1 minute', keyGenerator: adminKey } },
    })

    await fastify.register(async (admin) => {
        // Allowlist runs first: a disallowed source gets the plain 404 and costs no hashing.
        admin.addHook('onRequest', async (request, reply) => {
            request.adminIp = adminClientIp(request)
            if (!isAllowedIp(request.adminIp)) {
                reply.status(404)
                return reply.send({ error: `API route ${request.method}:${request.url.split('?')[0]} not found` })
            }
            reply.header('Cache-Control', 'no-store')
            reply.header('Pragma', 'no-cache')
            // A replica's DB is a read-only follower: no sessions, audit or credential writes.
            if (adminReadOnly() && !request.routeOptions.config?.adminReplicaOk) {
                reply.status(403)
                return reply.send({ error: 'The Dashboard is not available on a read-only replica. Sign in on the primary.' })
            }
            const chainError = forwardedInfo(request).error
            if (chainError) {
                reply.status(400)
                return reply.send({
                    error: chainError === 'short-chain'
                        ? 'The X-Forwarded-For chain has fewer entries than TRUST_PROXY_HOPS. Set TRUST_PROXY_HOPS to the number of proxies in front of the server.'
                        : 'An X-Forwarded-For entry written by a trusted proxy is not an IP address. Check that each proxy appends the client address and nothing else.',
                })
            }
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                const type = String(request.headers['content-type'] || '').toLowerCase()
                // A bodiless DELETE carries nothing to parse; CSRF header and Origin still apply.
                const bodiless = request.method === 'DELETE' && !type && !Number(request.headers['content-length'] || 0) && !request.headers['transfer-encoding']
                if (!bodiless && !type.startsWith('application/json')) {
                    reply.status(415)
                    return reply.send({ error: 'Content-Type must be application/json' })
                }
                if (!originMatches(request)) {
                    reply.status(403)
                    return reply.send({ error: ORIGIN_MISMATCH })
                }
            }
        })

        admin.addHook('preHandler', async (request, reply) => {
            const config = request.routeOptions.config || {}
            if (config.adminPublic) return
            // A replica never writes, session touch included; its reads stay valid.
            const session = await sessions.validate(readAdminCookie(request), Date.now(), { touch: !adminReadOnly() })
            if (!session) {
                reply.status(401)
                return reply.send(UNAUTHORIZED)
            }
            if (request.method !== 'GET' && request.method !== 'HEAD' && !safeEqual(request.headers['x-admin-csrf'], session.csrf)) {
                reply.status(403)
                return reply.send({ error: 'Missing or invalid CSRF token' })
            }
            request.adminSession = session
        })

        admin.addHook('onSend', async (request, reply) => {
            for (const name of Object.keys(reply.getHeaders())) {
                if (name.toLowerCase().startsWith('access-control-')) reply.removeHeader(name)
            }
        })

        admin.get('/status', opts({ adminPublic: true, adminReplicaOk: true }), async (request) => {
            if (adminReadOnly()) return { enabled: true, setupRequired: false, setupAvailable: false, signedIn: false, readOnlyReplica: true, rememberedBrowser: false }
            const cookie = readAdminCookie(request)
            const session = cookie ? await sessions.validate(cookie, Date.now(), { touch: false }) : null
            const rememberedBrowser = verifyRememberedDeviceToken(readCookies(request).get(DEVICE_COOKIE), deviceCredential())
            return { enabled: true, setupRequired: !storedHash, setupAvailable: setupPending(), signedIn: Boolean(session), readOnlyReplica: false, rememberedBrowser }
        })

        admin.post('/setup', opts({ adminPublic: true, max: 10 }), async (request, reply) => {
            if (!setupPending()) {
                reply.status(409)
                return { error: 'Dashboard setup is not available' }
            }
            const misconfig = proxyMisconfig(request)
            if (misconfig) { reply.status(400); return { error: misconfig } }
            const problem = transportProblem(request)
            if (problem) { reply.status(403); return { error: problem } }
            const body = request.body && typeof request.body === 'object' ? request.body : {}
            const supplied = typeof body.setupToken === 'string' ? body.setupToken : body.token
            const presented = typeof supplied === 'string' ? supplied : ''
            const result = await attempt(request, reply, async () => setupPending() && crypto.timingSafeEqual(sha256(presented), setupToken.hash))
            if (result.body) return result.body
            if (!result.ok) {
                auditBestEffort(request, { event: 'setup.fail', result: 'denied' })
                reply.status(401)
                return INVALID
            }
            const invalid = usernameProblem(body.username)
                || (typeof body.password === 'string' && body.password !== body.confirmPassword ? 'Passwords do not match' : null)
                || passphraseProblem(body.password)
            if (invalid) { reply.status(400); return { error: invalid } }
            if (kdfCurrent && !(await waitForKdf(privilegedPeer(request)))) return refuseBusy(reply)
            const hash = await withKdf(() => hashAdminPassphrase(body.password))
            const username = normalizeAdminUsername(body.username)
            const now = Date.now()
            const inserted = await db.run(
                'INSERT INTO admin_credentials (id, username, secret_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
                ['primary', username, hash, now, now]
            )
            if (!inserted.changes) {
                reply.status(409)
                return { error: 'Dashboard setup is not available' }
            }
            storedHash = hash
            storedUser = username
            setupToken = null
            await appendAudit({ ...auditCtx(request), event: 'setup.complete' })
            const remember = body.remember === true
            const issued = await issueSession(request, reply, { remember })
            await appendAudit({ ...auditCtx(request), event: 'login.success', details: { via: 'setup', ...(remember ? { remembered: true } : {}) } })
            return issued
        })

        admin.post('/login', opts({ adminPublic: true, max: 20 }), async (request, reply) => {
            const misconfig = proxyMisconfig(request)
            if (misconfig) { reply.status(400); return { error: misconfig } }
            const problem = transportProblem(request)
            if (problem) { reply.status(403); return { error: problem } }
            const body = request.body && typeof request.body === 'object' ? request.body : {}
            const result = await attempt(request, reply, () => verifyAdminLogin(body.username, body.password, storedUser, storedHash))
            if (result.body) return result.body
            if (!result.ok) {
                auditBestEffort(request, { event: 'login.fail', result: 'denied' })
                reply.status(401)
                return LOGIN_INCORRECT
            }
            const remember = body.remember === true
            const issued = await issueSession(request, reply, { remember })
            await auditBestEffort(request, { event: 'login.success', ...(remember ? { details: { remembered: true } } : {}) })
            return issued
        })

        admin.post('/logout', opts(), async (request, reply) => {
            await sessions.remove(request.adminSession.idHash)
            clearCookies(reply)
            await auditBestEffort(request, { event: 'logout' })
            return { ok: true }
        })

        admin.get('/session', opts(), async (request) => {
            const s = request.adminSession
            return { csrf: s.csrf, expiresAt: s.expiresAt, idleExpiresAt: s.idleExpiresAt }
        })

        admin.get('/sessions', opts(), async (request) => {
            const rows = await sessions.list()
            return {
                items: rows.map((r) => ({
                    id: sessionHandle(r.idHash),
                    current: r.idHash === request.adminSession.idHash,
                    createdAt: r.createdAt,
                    lastSeenAt: r.lastSeenAt,
                    expiresAt: r.expiresAt,
                    ipPrefix: r.ipPrefix,
                    uaFamily: r.uaFamily,
                })),
            }
        })

        admin.delete('/sessions/:id', opts(), async (request, reply) => {
            const handle = String(request.params.id || '')
            const isCurrent = sessionHandle(request.adminSession.idHash) === handle
            const removed = await sessions.removeByHandle(handle)
            if (!removed) { reply.status(404); return { error: 'Session not found' } }
            if (isCurrent) clearCookies(reply)
            await auditBestEffort(request, { event: 'session.revoke', details: { current: isCurrent } })
            return { ok: true, revoked: removed }
        })

        admin.post('/sessions/revoke-all', opts(), async (request, reply) => {
            const revoked = await sessions.removeAll()
            clearCookies(reply, { device: true })
            await auditBestEffort(request, { event: 'session.revoke_all', details: { count: revoked } })
            return { ok: true, revoked }
        })

        admin.get('/audit', opts(), async (request) => {
            const { cursor, limit } = request.query || {}
            const page = await listAudit({ before: cursor && /^\d+$/.test(String(cursor)) ? Number(cursor) : null, limit })
            return { ...page, retentionNote: AUDIT_RETENTION_NOTE }
        })

        admin.get('/audit/verify', opts({ max: 10 }), async () => {
            const { checked, ...rest } = await verifyAuditChain()
            return { ...rest, rows: checked, verifiedAt: new Date().toISOString() }
        })

        admin.get('/overview', opts(), async () => reads.overview())
        admin.get('/system', opts(), async () => reads.system())
        admin.get('/autopilot', opts(), async () => reads.autopilot())
        admin.get('/activity-engine', opts(), async () => reads.activity())
        admin.get('/tasks', opts(), async () => reads.tasks())
        admin.get('/cache', opts(), async () => reads.cache())
        admin.get('/metrics', opts(), async () => reads.metrics())
        // Writes answer per-key errors with 400 and save nothing; each save is one audit entry.
        const settingsCall = async (request, reply, fn) => {
            try {
                return await fn({ ...auditCtx(request) })
            } catch (err) {
                if (!(err instanceof SettingsError)) throw err
                reply.status(err.status)
                return err.errors ? { error: err.message, errors: err.errors } : { error: err.message }
            }
        }
        const body = (request) => (request.body && typeof request.body === 'object' ? request.body : {})
        admin.get('/settings', opts(), async () => settings.view())
        admin.patch('/settings', { ...opts({ max: 30 }), bodyLimit: SETTINGS_BODY_LIMIT }, async (request, reply) => settingsCall(request, reply, async (ctx) => {
            const result = await settings.save(body(request).changes, ctx)
            return { ...result, settings: await settings.view() }
        }))
        admin.post('/settings/adopt', opts({ max: 30 }), async (request, reply) => settingsCall(request, reply, async (ctx) => {
            const result = await settings.adopt(body(request).keys, ctx)
            return { ...result, settings: await settings.view() }
        }))
        admin.get('/settings/export', opts({ max: 30 }), async () => settings.exportValues())
        admin.post('/settings/import', { ...opts({ max: 30 }), bodyLimit: SETTINGS_BODY_LIMIT }, async (request, reply) => settingsCall(request, reply, async (ctx) => {
            const b = body(request)
            const result = await settings.importValues(b.file, { apply: b.apply === true }, ctx)
            return b.apply === true ? { ...result, settings: await settings.view() } : result
        }))

        // Error class and code only: a DB error message can carry row values.
        let usersWarnedAt = 0
        const usersUnavailable = (reply, err) => {
            const now = Date.now()
            if (now - usersWarnedAt >= USERS_FAIL_TTL_MS) {
                usersWarnedAt = now
                const cls = /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(err?.constructor?.name || '') ? err.constructor.name : 'Error'
                const code = typeof err?.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(err.code) ? `, ${err.code}` : ''
                log.warn({ category: 'Dashboard' }, `Dashboard: the account read failed (${cls}${code}); /users answers 503 until it recovers.`)
            }
            reply.status(503)
            return USERS_UNAVAILABLE
        }

        admin.get('/users', opts(), async (request, reply) => {
            const { filter, cursor, limit, q, sort, order } = request.query || {}
            try {
                return await reads.listUsers({
                    filter: typeof filter === 'string' ? filter : 'all',
                    cursor,
                    limit,
                    q: q === undefined ? null : q,
                    sort: typeof sort === 'string' ? sort : 'lastseen',
                    order: typeof order === 'string' ? order : 'desc',
                })
            } catch (err) {
                if (err?.code === 'query_invalid') {
                    reply.status(400)
                    return { error: 'query_invalid', message: err.message }
                }
                return usersUnavailable(reply, err)
            }
        })

        // Operator account actions (DP-05). Every mutation is one audited transaction
        // with a fixed-template notice; resolved keys never cross the wire.
        const accountActions = createAccountActions({ log })
        const bulkDelete = createBulkDelete({ users: reads.users, log })
        const actionAudit = (request) => auditCtx(request)
        const actionBody = (request) => (request.body && typeof request.body === 'object' ? request.body : {})
        const sessionHash = (request) => request.adminSession?.idHash || 'anonymous'

        admin.get('/users/bulk-delete/preview', opts({ max: 30 }), async (request, reply) => {
            try {
                return await bulkDelete.preview(reply, sessionHash(request))
            } catch (err) {
                return usersUnavailable(reply, err)
            }
        })

        admin.post('/users/bulk-delete', opts({ max: 3 }), async (request, reply) => {
            return bulkDelete.confirm(reply, sessionHash(request), actionBody(request), actionAudit(request))
        })

        const accountAction = (path, max, run) => {
            admin.post(`/users/:handle/${path}`, opts({ max }), async (request, reply) => {
                return run(reply, String(request.params.handle || ''), actionBody(request), actionAudit(request))
            })
        }
        accountAction('disable', 20, (reply, handle, body, audit) => accountActions.disable(reply, handle, body, audit))
        accountAction('enable', 20, (reply, handle, body, audit) => accountActions.enable(reply, handle, body, audit))
        accountAction('delete', 20, (reply, handle, body, audit) => accountActions.remove(reply, handle, body, audit))
        accountAction('restore', 20, (reply, handle, body, audit) => accountActions.restore(reply, handle, body, audit))
        accountAction('signout-devices', 10, (reply, handle, body, audit) => accountActions.signoutDevices(reply, handle, body, audit))

        // Tier-1 repairs (DP-04). The catalog and dry runs are read-only and stay
        // available on a replica; the run is a state-gated write refused with 503.
        const repairs = createRepairs({ log, autopilotEngine, reconciler })
        admin.get('/users/:handle/repairs', opts({ adminReplicaOk: true }), async (request, reply) => {
            return repairs.catalogAndHistory(reply, String(request.params.handle || ''))
        })
        admin.post('/users/:handle/repairs/:key', opts({ adminReplicaOk: true, max: 10 }), async (request, reply) => {
            return repairs.run(reply, String(request.params.handle || ''), String(request.params.key || ''), actionBody(request), actionAudit(request))
        })

        admin.get('/users/:handle', opts(), async (request, reply) => {
            let user
            try { user = await reads.getUser(request.params.handle) } catch (err) { return usersUnavailable(reply, err) }
            if (!user) { reply.status(404); return { error: 'Account not found' } }
            return user
        })

        // Search, filters and cursor paging all run over the already-redacted ring; a bad or
        // runaway pattern answers 400 with no partial data.
        admin.get('/logs', opts(), async (request, reply) => {
            const { after, cursor, level, limit, module, q, regex, since } = request.query || {}
            const page = logsPage({
                after,
                cursor,
                level: typeof level === 'string' ? level : null,
                module: typeof module === 'string' ? module : null,
                since,
                q: typeof q === 'string' ? q : null,
                regex: regex === '1' || regex === 'true',
                limit,
            })
            if (page.error) { reply.status(400); return { error: page.error } }
            return { ...page, redaction: 'Allowlisted before storage. Instance-level messages keep their text, sync and Autopilot events show as templates with account labels, counts and error codes only, and anything else reads "details hidden". Ids and foreign hosts are masked and IPs are removed.' }
        })

        // Export serves the same redacted wire lines as attachments; one audit row per export,
        // format and count only, never line content.
        admin.get('/logs/export', opts({ max: 30 }), async (request, reply) => {
            const { format, q, regex, level, module, since, cursor, after } = request.query || {}
            if (format !== undefined && format !== 'log' && format !== 'ndjson') { reply.status(400); return { error: 'format_invalid' } }
            const kind = format === 'ndjson' ? 'ndjson' : 'log'
            const filtered = logsForExport({
                q: typeof q === 'string' ? q : null,
                regex: regex === '1' || regex === 'true',
                level: typeof level === 'string' ? level : null,
                module: typeof module === 'string' ? module : null,
                since, cursor, after,
            })
            if (filtered.error) { reply.status(400); return { error: filtered.error } }
            const text = (kind === 'ndjson'
                ? filtered.lines.map((l) => JSON.stringify(l))
                : filtered.lines.map((l) => `${l.at} ${l.level.padEnd(5)} [${l.module}] ${l.message} (seq ${l.seq})`)
            ).join('\n')
            await auditBestEffort(request, { event: 'logs.export', details: { format: kind, count: filtered.lines.length } })
            reply.header('Content-Type', kind === 'ndjson' ? 'application/x-ndjson; charset=utf-8' : 'text/plain; charset=utf-8')
            reply.header('Content-Disposition', `attachment; filename="dashboard-logs-${new Date().toISOString().slice(0, 10)}.${kind}"`)
            reply.header('X-Content-Type-Options', 'nosniff')
            return text + (text ? '\n' : '')
        })

        // Server-sent events; hijacked so compression and buffering never hold lines back.
        admin.get('/logs/stream', opts({ max: 10 }), async (request, reply) => {
            if (logListenerCount() >= MAX_LOG_VIEWERS) { reply.status(429); return { error: 'Too many live log viewers. Close another Dashboard log tab.' } }
            const raw = reply.raw
            let closed = false
            let unsubscribe = () => {}
            let heartbeat = null
            let recheck = null
            const close = () => {
                if (closed) return
                closed = true
                unsubscribe()
                clearInterval(heartbeat)
                clearInterval(recheck)
                try { raw.end() } catch { /* already gone */ }
            }
            const send = (entry) => { if (!closed) sseWrite(raw, entry, close) }
            const cookie = readAdminCookie(request)
            reply.hijack()
            raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' })
            // New lines only; a backlog replays only on resume (Last-Event-ID or ?after), so it never repeats GET /logs.
            const after = Number(request.headers['last-event-id'] || request.query?.after) || 0
            if (after > 0) for (const entry of readLogs({ after, limit: 200 }).items) send(entry)
            raw.write(': connected\n\n')
            unsubscribe = subscribeLogs(send) || (() => {})
            heartbeat = setInterval(() => { if (raw.writableLength > SSE_MAX_BUFFERED) close(); else raw.write(': ping\n\n') }, SSE_HEARTBEAT_MS)
            recheck = setInterval(async () => {
                const live = await sessions.validate(cookie, Date.now(), { touch: false }).catch(() => null)
                if (!live) close()
            }, SSE_RECHECK_MS)
            heartbeat.unref?.()
            recheck.unref?.()
            request.raw.on('close', close)
            raw.on('error', close)
        })

        admin.get('/queue-stats', opts({ max: 30 }), async () => {
            let busiestKeyCount = 0
            for (const count of proxyQueueKeyCounts.values()) busiestKeyCount = Math.max(busiestKeyCount, count)
            return { queueLength: proxyQueue.length, activeRequests: serverState.activeProxyRequests, distinctKeys: proxyQueueKeyCounts.size, busiestKeyCount }
        })

        admin.get('/cache-stats', opts({ max: 30 }), async (request, reply) => {
            try {
                return await metadataCache.getStats()
            } catch {
                reply.status(500)
                return { error: 'Failed to compute stats' }
            }
        })
    }, { prefix: '/api/admin' })

    log.info({ category: 'Dashboard' }, `Dashboard enabled${storedHash ? '' : ' (setup required)'}${adminReadOnly() ? ' in read-only replica mode' : ''}.`)
    return { enabled: true, limiter, sessions, hashSessionId, reads, sampler: systemSampler }
}
