import { globalHealthCache, healthCheckInFlight } from '../state.js'
import { normalizeAddonUrl } from '../utils/addon-url.js'
import { maskContext } from '../utils/log-helpers.js'
import { enqueueProxyRequest } from '../proxy-queue.js'
import { isSafeUrl } from '../utils/ssrf.js'
import { guardedFetch } from '../utils/safe-fetch.js'
import { trace } from '../utils/trace.js'
import { urlRef } from './v1/url-ref.js'
import { VERDICT, STRENGTH, PEEK_BYTES, registrableDomain, classifyResponse, classifyTransport, takeSignalCounts, responseFingerprint } from './health-signals.js'
import { createHostHealthTable, STATE, FAIL_STREAK, outcomeOf } from './host-health-table.js'

export const HEALTH_CACHE_TTL_MS = Math.max(10000, parseInt(process.env.AUTOPILOT_HEALTH_CACHE_TTL_MS || '30000', 10) || 30000)

// Probe timeouts: connect 5 s and response 6 s, each retried once after 1 s.
export const PROBE_TIMEOUT_MS = 6000
// Manifest reads retry a reset or refused connection once, like the host probe. TLS failures are down.
const NETWORK_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT', 'EADDRINUSE', 'ECONNREFUSED', 'connect-timeout']
const isNetworkProbeError = (err) => NETWORK_ERROR_CODES.includes(err?.transportCode ?? err?.code)
// Same cap as the manifest refresh fetch, so any manifest the engine can install can also be checked.
export const MANIFEST_PROBE_MAX_BYTES = 5 * 1024 * 1024
// Shared hosts serve one unique manifest per user, so manifest probes skip the per-origin spacing and are
// capped by in-flight requests per host instead.
export const MANIFEST_PROBES_PER_HOST = Math.max(1, parseInt(process.env.AUTOPILOT_MANIFEST_PROBES_PER_HOST || '6', 10) || 6)
const hostSlots = new Map()
// Backup reads across all hosts share one cap, so a CDN-wide SUSPECT cycle cannot take the sockets pings need.
const BACKUP_READS_MAX = 64
const readSlots = new Map()
const acquireSlot = (slots, host, limit) => {
    let slot = slots.get(host)
    if (!slot) slots.set(host, slot = { active: 0, waiters: [] })
    const release = () => {
        const next = slot.waiters.shift()
        if (next) return next(release)
        slot.active--
        if (slot.active === 0) slots.delete(host)
    }
    if (slot.active < limit) {
        slot.active++
        return Promise.resolve(release)
    }
    return new Promise(resolve => slot.waiters.push(resolve))
}
const acquireHostSlot = (host) => acquireSlot(hostSlots, host, MANIFEST_PROBES_PER_HOST)

// Health verdicts are shared per exact fetch target: scheme and host fold case, path and query keep it.
const exactKey = (url) => { try { return new URL(url).href } catch { return String(url) } }

const PROBE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const PROBE_HEADERS = Object.freeze({ 'User-Agent': PROBE_USER_AGENT, 'Accept': 'application/json, text/plain, */*' })

const UNDICI_CONNECT_TIMEOUT_MS = 5000

// Default probe transport: connect-time SSRF guard (no fail-open), no redirect following, headers plus the
// first PEEK_BYTES of the body. The caller's abort rejects as an AbortError; transport failures keep their code.
export const guardedProbeFetch = async (url, { method = 'GET', headers, signal, redirect = 'manual', timeoutMs = PROBE_TIMEOUT_MS, onLookup = null } = {}) => {
    try {
        return await guardedFetch(String(url), {
            method, headers, signal, redirect, maxHops: 0, peekBytes: PEEK_BYTES, clockFromLookup: true, onLookup,
            connectTimeoutMs: Math.min(UNDICI_CONNECT_TIMEOUT_MS, timeoutMs), totalTimeoutMs: timeoutMs + 1000,
        })
    } catch (err) {
        if (err?.code === 'timeout' && signal?.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError', code: 'timeout', phase: err.phase })
        throw err
    }
}

// Manifest transport: the same connect-time guard, reading the body up to the size cap.
export const guardedManifestProbeFetch = async (url, { method = 'GET', headers, signal, redirect = 'manual', timeoutMs = PROBE_TIMEOUT_MS } = {}) => {
    try {
        return await guardedFetch(String(url), {
            method, headers, signal, redirect, maxHops: 0, maxBytes: MANIFEST_PROBE_MAX_BYTES,
            connectTimeoutMs: Math.min(UNDICI_CONNECT_TIMEOUT_MS, timeoutMs), totalTimeoutMs: timeoutMs + 1000,
        })
    } catch (err) {
        if (err?.code === 'timeout' && signal?.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError', code: 'timeout' })
        throw err
    }
}

// The URL Stremio installs from: chain entries are transport URLs, normally already ending in manifest.json.
export const manifestUrlFor = (url) => {
    if (/\/manifest\.json(?:[?#]|$)/i.test(String(url))) return String(url)
    try {
        const u = new URL(url)
        u.pathname = `${u.pathname.replace(/\/+$/, '')}/manifest.json`
        return u.toString()
    } catch { return String(url) }
}

// safeFetchWithRedirects semantics over an injectable transport: each hop is its own guarded request.
export async function fetchWithHops(fetchImpl, url, { signal, headers, method = 'HEAD', maxHops = 3, methodFallback = false, timeoutMs } = {}) {
    if (!isSafeUrl(url)) return null
    const reqHeaders = { ...PROBE_HEADERS, ...(headers || {}) }
    let currentUrl = url
    for (let hop = 0; hop <= maxHops; hop++) {
        const init = { method, signal, redirect: 'manual', headers: reqHeaders, timeoutMs }
        let res = await fetchImpl(currentUrl, init)
        if (methodFallback && method === 'HEAD' && (res.status === 405 || res.status === 404)) {
            res = await fetchImpl(currentUrl, { ...init, method: 'GET' })
        }
        if (res.status >= 300 && res.status < 400) {
            if (hop >= maxHops) return null
            const location = res.headers.get('location')
            if (!location) return null
            let nextUrl
            try { nextUrl = new URL(location, currentUrl).toString() } catch { return null }
            if (!isSafeUrl(nextUrl)) return null
            currentUrl = nextUrl
            continue
        }
        return res
    }
    return null
}

// The first PEEK_BYTES bytes of a body, as the probe transport keeps them, so ping and read peeks compare.
export const peekOf = (text) => Buffer.from(text, 'utf8').subarray(0, PEEK_BYTES).toString('utf8')

// A body that stalls after the headers ends at the caller's abort; the headers are classified as they are.
const readPeek = async (res, signal) => {
    try {
        const stalled = new Promise((resolve) => {
            if (signal?.aborted) return resolve('')
            signal?.addEventListener('abort', () => resolve(''), { once: true })
        })
        return peekOf(String(await Promise.race([res.text(), stalled])))
    } catch { return '' }
}

// A probe timeout is judged by the phase it hit: waiting for our own socket or for the lookup defers, a
// stalled connect is connect-timeout, and connected with no response headers is a hung app. A hung root page
// (a configure page Stremio never loads) is only HTTP-level evidence, so a backup read decides.
const PHASE_CODES = { queued: 'probe-queued', lookup: 'dns-timeout', connect: 'connect-timeout' }
const classifyPingError = (err, target) => {
    if ((err?.name !== 'AbortError' && err?.code !== 'timeout') || err.phase === 'body') return classifyTransport(err)
    const code = PHASE_CODES[err.phase] ?? 'ping-timeout'
    const result = classifyTransport({ code })
    return code === 'ping-timeout' && target.kind === 'root' ? { ...result, strength: STRENGTH.H } : result
}

const isCrossSite = (res, probeUrl) => {
    if (res.status < 300 || res.status >= 400) return false
    const location = res.headers?.get?.('location')
    if (!location) return false
    try {
        return registrableDomain(new URL(location, probeUrl).hostname) !== registrableDomain(new URL(probeUrl).hostname)
    } catch { return true }
}

// Usable for a decision outside the rule loop: up, recovering, or not yet judged bad.
const isUsable = (status) => status.state === STATE.UP || status.state === STATE.RECOVERING
    || ((status.state === STATE.UNKNOWN || status.state === STATE.FAILING) && outcomeOf(status.verdict) !== 'bad')

// A chain member is as healthy as its worst part: its own target and the custom checks that apply to it.
// A custom check that has never answered (unreachable, so deferred) is neutral rather than UNKNOWN.
const STATE_RANK = { [STATE.UP]: 0, [STATE.UNKNOWN]: 1, [STATE.FAILING]: 2, [STATE.RECOVERING]: 3, [STATE.DOWN]: 4 }
const combineStatuses = ([host, ...custom]) => {
    const statuses = [host, ...custom.filter(s => s.state !== STATE.UNKNOWN)]
    const worst = statuses.reduce((w, s) => (STATE_RANK[s.state] > STATE_RANK[w.state] ? s : w))
    return {
        state: worst.state,
        goodStreak: Math.min(...statuses.map(s => s.goodStreak)),
        badStreak: Math.max(...statuses.map(s => s.badStreak)),
        latencyMs: statuses[0].latencyMs,
        row: worst.row ?? null,
        status: worst.status ?? null,
    }
}

export function createHealthChecker(fastify, { fetch: injectedFetch, now = () => Date.now(), retryDelayMs = 1000, probeTimeoutMs = PROBE_TIMEOUT_MS, pingBudgetMs = 20000, gateBudgetMs } = {}) {
    const probeFetch = injectedFetch ?? guardedProbeFetch
    const manifestFetch = injectedFetch ?? guardedManifestProbeFetch
    // Targets already warned about as deferred (challenged, rate limited); repeats log at debug.
    const deferWarned = new Set()

    // One GET per target, classified by the signal table. A 5xx retries at once; transport rows say whether
    // they retry (after retryDelayMs). responseMs is the final attempt only, so a retry never reads as slow.
    // The table runs pings as its own pipeline, capped per origin.
    const probeTarget = async (target, logRef, { deadlineAt = Infinity } = {}) => {
        const startTime = Date.now()
        // One attempt can take the lookup timer plus the response budget; an in-check retry runs only if
        // another such attempt still fits before the cutoff the caller passes (the cycle's breaker sample).
        const attemptMs = Math.min(UNDICI_CONNECT_TIMEOUT_MS, probeTimeoutMs) + probeTimeoutMs
        const retryFits = (delayMs) => Date.now() + delayMs + attemptMs <= deadlineAt
        for (let attempt = 0; ; attempt++) {
            const controller = new AbortController()
            // The response clock and responseMs restart when the lookup finishes, so a slow resolver neither eats
            // the budget nor reads as a slow host.
            let timer = setTimeout(() => controller.abort(), probeTimeoutMs)
            let fetchStart = Date.now()
            let outcome
            try {
                const res = await probeFetch(target.probeUrl, { method: 'GET', signal: controller.signal, redirect: 'manual', headers: PROBE_HEADERS, timeoutMs: probeTimeoutMs,
                    onLookup: () => {
                        fetchStart = Date.now()
                        clearTimeout(timer)
                        timer = setTimeout(() => controller.abort(), probeTimeoutMs)
                    },
                })
                const peek = await readPeek(res, controller.signal)
                const responseMs = Date.now() - fetchStart
                const header = (name) => res.headers?.get?.(name) ?? null
                outcome = { ...classifyResponse({ status: res.status, header, peek, responseMs, crossSite: isCrossSite(res, target.probeUrl), target }), status: res.status, responseMs, fingerprint: responseFingerprint({ status: res.status, header, peek }) }
                if (res.status >= 500 && outcome.verdict !== VERDICT.DEFER && outcome.strength !== STRENGTH.T && attempt < 1 && retryFits(0)) continue
            } catch (err) {
                outcome = { ...classifyPingError(err, target), status: null, responseMs: Date.now() - fetchStart }
                if (attempt < outcome.retry && retryFits(retryDelayMs)) {
                    clearTimeout(timer)
                    await new Promise(r => setTimeout(r, retryDelayMs))
                    continue
                }
            } finally {
                clearTimeout(timer)
            }
            if (outcome.verdict === VERDICT.DEFER) {
                const first = !deferWarned.has(target.key)
                if (first) {
                    if (deferWarned.size >= 20000) deferWarned.clear()
                    deferWarned.add(target.key)
                }
                fastify.log[first ? 'warn' : 'debug']({ category: 'Autopilot' }, `Health check deferred (${outcome.row}): ${logRef}`)
            } else {
                deferWarned.delete(target.key)
            }
            return { ...outcome, latencyMs: Date.now() - startTime }
        }
    }

    // One backup read of a URL in use, as host evidence only (classifyManifestRead). No retry. The budget
    // starts before the wait for a host slot, so a busy host cannot stretch the cycle's reads.
    const readManifest = async (url, budgetMs) => {
        const target = manifestUrlFor(url)
        let queueKey = target
        try { queueKey = new URL(target).origin } catch (e) { }
        const controller = new AbortController()
        const budget = setTimeout(() => controller.abort(), budgetMs)
        const spent = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true }))
        // The host slot comes first, so reads queued on one busy origin never hold global slots another host's
        // read needs. A read whose budget runs out while queued is no evidence.
        const slot = acquireHostSlot(queueKey)
        const release = await Promise.race([slot, spent])
        if (!release) {
            clearTimeout(budget)
            slot.then(r => r())
            return { queued: true }
        }
        const anySlot = acquireSlot(readSlots, 'all', BACKUP_READS_MAX)
        const releaseAny = await Promise.race([anySlot, spent])
        if (!releaseAny) {
            clearTimeout(budget)
            anySlot.then(r => r())
            release()
            return { queued: true }
        }
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
        try {
            const res = await fetchWithHops(manifestFetch, target, { method: 'GET', signal: controller.signal, maxHops: 0, timeoutMs: PROBE_TIMEOUT_MS })
            if (!res) return { status: 0 }
            const header = (name) => res.headers?.get?.(name) ?? null
            if (res.status >= 200 && res.status < 300) {
                const text = String(await res.text())
                const { id } = await readManifestId({ text: async () => text })
                return { status: res.status, header, manifestId: id, peek: peekOf(text) }
            }
            return { status: res.status, header, peek: await readPeek(res) }
        } catch (error) {
            return { error }
        } finally {
            clearTimeout(timer)
            clearTimeout(budget)
            release()
            releaseAny()
        }
    }

    const table = createHostHealthTable({
        now,
        log: fastify.log,
        pingBudgetMs,
        ...(gateBudgetMs != null ? { gateBudgetMs } : {}),
        readManifest: (url, budgetMs) => readManifest(url, budgetMs),
        ping: (target, opts) => probeTarget(target, target.kind === 'custom' ? urlRef(target.probeUrl, 'ck') : urlRef(target.origin, 'host'), opts),
    })

    // Healthy means the manifest Stremio installs from answers 2xx with JSON carrying an id. A 429 defers
    // (counts healthy); a 5xx or a response timeout is retried once.
    const readManifestId = async (res) => {
        const text = await res.text()
        if (Buffer.byteLength(text, 'utf8') > MANIFEST_PROBE_MAX_BYTES) return { id: null, reason: 'too-large' }
        let parsed
        try { parsed = JSON.parse(text) } catch { return { id: null, reason: 'bad-json' } }
        const manifest = parsed?.manifest || parsed
        return typeof manifest?.id === 'string' && manifest.id ? { id: manifest.id, reason: null } : { id: null, reason: 'no-id' }
    }

    const probeManifest = (target, logRef, retries) => {
        let queueKey = target
        try { queueKey = new URL(target).origin } catch (e) { }
        return acquireHostSlot(queueKey).then(async (release) => {
            try {
                return await runManifestProbe(target, logRef, retries, queueKey)
            } finally {
                release()
            }
        })
    }

    const runManifestProbe = (target, logRef, retries, queueKey) => {
        const startTime = Date.now()
        return enqueueProxyRequest(target, async () => {
            let reachable = false
            const done = (healthy, reason = null) => ({ healthy, reachable, reason, latencyMs: Date.now() - startTime })
            for (let attempt = 0; attempt <= Math.max(retries, 1); attempt++) {
                const controller = new AbortController()
                const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
                try {
                    const res = await fetchWithHops(manifestFetch, target, { method: 'GET', signal: controller.signal, timeoutMs: PROBE_TIMEOUT_MS })
                    if (!res) return done(false, 'unsafe-redirect')
                    reachable = true
                    if (res.status === 429) {
                        fastify.log.warn({ category: 'Autopilot' }, `Manifest check rate limited (429), deferring: ${logRef}`)
                        return done(true, 'rate-limited')
                    }
                    if (res.status >= 500 && attempt < retries) continue
                    if (!res.ok) return done(false, `status-${res.status}`)
                    const { id, reason } = await readManifestId(res)
                    return done(!!id, reason)
                } catch (err) {
                    if (err?.code === 'too-large') return done(false, 'too-large')
                    if (err?.name === 'AbortError') {
                        reachable = true
                        if (attempt < retries) {
                            await new Promise(r => setTimeout(r, 1000))
                            continue
                        }
                        return done(false, 'timeout')
                    }
                    if (isNetworkProbeError(err) && attempt < Math.max(retries, 1)) {
                        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
                        continue
                    }
                    return done(false, err?.code || 'request-failed')
                } finally {
                    clearTimeout(timeout)
                }
            }
            return done(false)
        }, { queueKey, throttleMs: 0 })
    }

    // The Addon Health route: the shared host verdict (cached up to a minute), then this URL's own manifest.
    const _performHealthCheck = async (url, healthKey, context) => {
        const logRef = urlRef(normalizeAddonUrl(url).toLowerCase())
        const host = await table.check(url)
        const hostDown = host.verdict === VERDICT.DOWN && host.transport
        const manifestOutcome = hostDown ? null : await probeManifest(manifestUrlFor(url), logRef, 1)
        const isHealthy = !!manifestOutcome?.healthy

        if (hostDown) {
            fastify.log.warn({ category: context }, `[Health] Host ${urlRef(url, 'host')} is unreachable.`)
        } else if (!isHealthy) {
            fastify.log.warn({ category: context }, `[Health] Manifest ${logRef} is unhealthy (${manifestOutcome?.reason || 'failed'}).`)
        }

        if (globalHealthCache.size > 20000) {
            const pruneNow = Date.now()
            for (const [key, val] of globalHealthCache.entries()) {
                if (pruneNow - val.timestamp > HEALTH_CACHE_TTL_MS) globalHealthCache.delete(key)
            }
            if (globalHealthCache.size > 15000) {
                while (globalHealthCache.size > 10000) {
                    const oldestKey = globalHealthCache.keys().next().value
                    if (oldestKey === undefined) break
                    globalHealthCache.delete(oldestKey)
                }
            }
        }
        globalHealthCache.set(healthKey, { isHealthy, latencyMs: host.latencyMs, manifestChecked: true, timestamp: Date.now() })
        return isHealthy
    }

    // Autopilot answers from the shared target state; only the Addon Health route reads this URL's manifest.
    const checkAddonHealthInternal = async (url, context = 'Autopilot') => {
        if (context === 'Autopilot') return isUsable(await table.check(url))
        const healthKey = exactKey(manifestUrlFor(url))
        const cached = globalHealthCache.get(healthKey)
        if (cached && Date.now() - cached.timestamp < HEALTH_CACHE_TTL_MS && cached.manifestChecked) return cached.isHealthy
        const inFlight = healthCheckInFlight.get(healthKey)
        if (inFlight) return inFlight
        const healthPromise = _performHealthCheck(url, healthKey, context)
            .finally(() => { if (healthCheckInFlight.get(healthKey) === healthPromise) healthCheckInFlight.delete(healthKey) })
        healthCheckInFlight.set(healthKey, healthPromise)
        return healthPromise
    }

    const getHealthLatency = (url) => table.peek(url)?.latencyMs ?? globalHealthCache.get(exactKey(manifestUrlFor(url)))?.latencyMs ?? null

    const reportCustom = (status, checkUrl, ruleId, accountId) => {
        const outcome = outcomeOf(status.verdict)
        if (outcome === 'bad') {
            trace('autopilot.customCheck', 'failed', { ruleId, check: urlRef(checkUrl, 'ck'), row: status.row })
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Custom check failed for ${urlRef(checkUrl, 'ck')} (${status.row})`)
        } else if (outcome === 'defer') {
            trace('autopilot.customCheck', 'deferred', { ruleId, check: urlRef(checkUrl, 'ck'), row: status.row })
        } else {
            trace('autopilot.customCheck', 'passed', { ruleId, check: urlRef(checkUrl, 'ck'), row: status.row })
        }
    }

    // A custom check URL the SSRF guard refuses, up front or at connect time, is a broken check and fails,
    // the same way for rule decisions and the deep audit.
    const refused = { key: null, state: STATE.DOWN, goodStreak: 0, badStreak: FAIL_STREAK, verdict: VERDICT.DOWN, row: 'blocked', strength: STRENGTH.T, transport: true, latencyMs: null }
    const customStatus = (checkUrl) => (isSafeUrl(checkUrl)
        ? table.checkCustom(checkUrl).then(status => (status.row === 'blocked' ? refused : status))
        : Promise.resolve(refused))

    // State of one chain member for one rule: its target plus the custom checks that apply to it.
    const memberStatus = async (url, { owner = null, inUse = false, customUrls = [], ruleId = null, accountId = null } = {}) => {
        const [host, ...custom] = await Promise.all([table.check(url, { owner, inUse }), ...customUrls.map(customStatus)])
        custom.forEach((status, i) => reportCustom(status, customUrls[i], ruleId, accountId))
        return custom.length > 0 ? combineStatuses([host, ...custom]) : host
    }

    const checkCustomUrlsHealth = async (urls, ruleId, accountId) => {
        if (!Array.isArray(urls) || urls.length === 0) return true
        trace('autopilot.customCheck', 'start', { ruleId, urlCount: urls.length })
        const statuses = await Promise.all(urls.map(customStatus))
        statuses.forEach((status, i) => reportCustom(status, urls[i], ruleId, accountId))
        return statuses.every(isUsable)
    }

    const beginProbeCycle = () => table.beginCycle()
    const endProbeCycle = () => {
        table.endCycle()
        const counts = { ...takeSignalCounts() }
        for (const [k, n] of Object.entries(table.takeStats())) if (n > 0) counts[k] = n
        if (Object.keys(counts).length > 0) fastify.log.info({ category: 'Autopilot', fmt: 'ap.health_signals', signals: counts, targets: table.size(), bytes: table.bytes() }, `Health signals this cycle: ${Object.entries(counts).map(([row, n]) => `${row}=${n}`).join(' ')}; targets=${table.size()} bytes=${table.bytes()}`)
    }

    return { checkAddonHealthInternal, getHealthLatency, checkCustomUrlsHealth, memberStatus, beginProbeCycle, endProbeCycle }
}
