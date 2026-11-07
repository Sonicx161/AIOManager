import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { isPrivateIp, isSafeUrl, isSafeUrlResolved } from './ssrf.js'
import { resilientFetch } from './api-resilience.js'

const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'api-key', 'apikey', 'x-sync-password'])
const CREDENTIAL_PATTERN = /(^|-)(api-?key|auth|token|secret|password|cookie)(-|$)/
const isCredentialHeader = (name) => { const n = name.toLowerCase(); return CREDENTIAL_HEADERS.has(n) || CREDENTIAL_PATTERN.test(n) }
export const stripCredentialHeaders = (headers) =>
    Object.fromEntries(Object.entries(headers || {}).filter(([k]) => !isCredentialHeader(k)))

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export async function safeFetchWithRedirects(url, { signal, headers, method = 'HEAD', maxHops = 3, methodFallback = false } = {}) {
    if (!(await isSafeUrlResolved(url))) return null

    let reqHeaders = { 'User-Agent': DEFAULT_USER_AGENT, 'Accept': 'application/json, text/plain, */*', ...(headers || {}) }
    let currentUrl = url

    for (let hop = 0; hop <= maxHops; hop++) {
        let res = await fetch(currentUrl, { method, signal, redirect: 'manual', headers: reqHeaders })
        if (methodFallback && method === 'HEAD' && (res.status === 405 || res.status === 404)) {
            res = await fetch(currentUrl, { method: 'GET', signal, redirect: 'manual', headers: reqHeaders })
        }

        if (res.status >= 300 && res.status < 400) {
            if (hop >= maxHops) return null
            const location = res.headers.get('location')
            if (!location) return null
            let nextUrl
            try { nextUrl = new URL(location, currentUrl).toString() } catch { return null }
            if (!(await isSafeUrlResolved(nextUrl))) return null
            if (new URL(nextUrl).origin !== new URL(currentUrl).origin) reqHeaders = stripCredentialHeaders(reqHeaders)
            currentUrl = nextUrl
            continue
        }

        return res
    }

    return null
}

const DEFAULT_MAX_BYTES = 1024 * 1024
const allowPrivateEnv = () => process.env.SSRF_ALLOW_PRIVATE === 'true' || process.env.SSRF_ALLOW_PRIVATE === '1'

const coded = (code, transportCode) => Object.assign(new Error(code), transportCode ? { code, transportCode } : { code })

export const isReservedAddress = (address) => {
    const ip = String(address || '').toLowerCase().replace(/^\[(.+)\]$/, '$1').split('%')[0]
    if (isPrivateIp(ip)) return true
    const mapped = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mapped) {
        const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16)
        return isReservedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    if (net.isIPv4(ip)) return parseInt(ip, 10) >= 224
    if (net.isIPv6(ip)) return ip.startsWith('ff') || /^fe[89a-f]/.test(ip)
    return false
}

// Validates every address the socket could connect to, at connect time, with no cache and no fail-open.
export function createGuardedLookup({ lookup = dns.lookup, allowPrivate = allowPrivateEnv } = {}) {
    return (hostname, options, cb) => {
        if (typeof options === 'function') { cb = options; options = {} }
        const query = { all: true, verbatim: true }
        if (options?.family) query.family = options.family
        if (options?.hints) query.hints = options.hints
        lookup(hostname, query, (err, addresses, family) => {
            // The resolver code (ENOTFOUND, EAI_AGAIN) tells a missing name from a resolver blip.
            if (err) return cb(coded('dns-failed', typeof err.code === 'string' ? err.code : undefined))
            const list = Array.isArray(addresses) ? addresses : (addresses ? [{ address: addresses, family }] : [])
            if (list.length === 0) return cb(coded('dns-failed'))
            if (!allowPrivate() && list.some((a) => isReservedAddress(a.address))) return cb(coded('ssrf-blocked'))
            if (options?.all) return cb(null, list)
            cb(null, list[0].address, list[0].family || (net.isIPv6(list[0].address) ? 6 : 4))
        })
    }
}

// Pooled sockets were validated when they connected and a connected socket's IP cannot change, so
// reuse is safe; every NEW socket goes through the guarded lookup because the lookup lives in the
// agent options. Pools are split by the allowPrivate answer at request time so a dev-override socket is
// never reused once the override is off, and by injected lookup so test stubs never enter the shared pool.
const POOL_OPTIONS = { keepAlive: true, keepAliveMsecs: 1000, maxSockets: 128, maxFreeSockets: 16, maxTotalSockets: 1024, timeout: 15000 }
const defaultDnsLookup = (...args) => dns.lookup(...args)
const pools = new Map()
const customPools = new WeakMap()

const buildPool = (lookup, allowPrivate) => {
    const guarded = createGuardedLookup({ lookup, allowPrivate: () => allowPrivate })
    return { http: new http.Agent({ ...POOL_OPTIONS, lookup: guarded }), https: new https.Agent({ ...POOL_OPTIONS, lookup: guarded }) }
}

export function agentPoolFor({ lookup, allowPrivate = allowPrivateEnv } = {}) {
    const allow = !!allowPrivate()
    if (!lookup) {
        if (!pools.has(allow)) pools.set(allow, buildPool(defaultDnsLookup, allow))
        return pools.get(allow)
    }
    let byFlag = customPools.get(lookup)
    if (!byFlag) customPools.set(lookup, byFlag = new Map())
    if (!byFlag.has(allow)) byFlag.set(allow, buildPool(lookup, allow))
    return byFlag.get(allow)
}

const STALE_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE'])

const decoderFor = (encoding) => {
    switch (String(encoding || '').toLowerCase()) {
        case 'gzip': case 'x-gzip': return zlib.createGunzip()
        case 'deflate': return zlib.createInflate()
        case 'br': return zlib.createBrotliDecompress()
        default: return null
    }
}

const omitHeaders = (headers, names) => {
    const drop = new Set(names)
    return Object.fromEntries(Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())))
}

const buildResult = (status, res, buffer) => {
    const text = buffer.toString('utf8')
    const headers = new Headers()
    for (const [k, v] of Object.entries(res.headers)) {
        for (const item of Array.isArray(v) ? v : [v]) headers.append(k, String(item))
    }
    return {
        status, statusText: res.statusMessage || '', ok: status >= 200 && status < 300, headers, buffer,
        text: async () => text, json: async () => JSON.parse(text),
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    }
}

const PASS_CODES = new Set(['ssrf-blocked', 'dns-failed', 'timeout', 'connect-timeout', 'too-large', 'too-many-redirects'])

// Fetch that validates the address the socket actually connects to (DNS-rebind safe). Errors carry a
// code only and never include the URL.
export function guardedFetch(url, {
    method = 'GET', headers, body, redirect = 'follow', signal, maxBytes = DEFAULT_MAX_BYTES, maxHops = 3,
    connectTimeoutMs = 5000, totalTimeoutMs = 10000, lookup, allowPrivate = allowPrivateEnv,
    defaultHeaders = true, discardBody = false, peekBytes = 0, clockFromLookup = false, onLookup = null,
} = {}) {
    let reqMethod = method
    let reqBody = body
    let reqHeaders = defaultHeaders
        ? { 'User-Agent': DEFAULT_USER_AGENT, 'Accept': 'application/json, text/plain, */*', ...(headers || {}) }
        : { ...(headers || {}) }
    return new Promise((resolve, reject) => {
        let done = false
        let current = null
        let total = null
        // queued (waiting for one of our sockets), lookup, connect, headers or body
        let phase = 'queued'
        // In peek mode a timeout after the headers keeps them: the caller classifies what did arrive.
        let peekExpire = null
        const expire = () => (peekExpire ? peekExpire() : fail('timeout'))
        const onAbort = expire
        const finish = (fn, value) => {
            if (done) return
            done = true
            clearTimeout(total)
            signal?.removeEventListener('abort', onAbort)
            fn(value)
        }
        const fail = (code, transportCode) => {
            current?.destroy()
            // Socket, TLS and resolver codes (ECONNRESET, CERT_HAS_EXPIRED, ENOTFOUND) stay readable on transportCode.
            const native = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : undefined
            const err = PASS_CODES.has(code) ? coded(code, transportCode) : coded('request-failed', transportCode ?? native)
            // A timeout says which phase it hit: waiting for the response headers, or reading the body.
            if (code === 'timeout') err.phase = phase
            finish(reject, err)
        }
        total = setTimeout(expire, totalTimeoutMs)
        if (signal) {
            if (signal.aborted) return fail('timeout')
            signal.addEventListener('abort', onAbort, { once: true })
        }

        const hop = (target, n, retriedStale = false) => {
            let u
            try { u = new URL(target) } catch { return fail('ssrf-blocked') }
            if (!isSafeUrl(u.toString())) return fail('ssrf-blocked')
            const host = u.hostname.replace(/^\[(.+)\]$/, '$1')
            if (net.isIP(host) && !allowPrivate() && isReservedAddress(host)) return fail('ssrf-blocked')
            const pool = agentPoolFor({ lookup, allowPrivate })
            const mod = u.protocol === 'https:' ? https : http
            let responded = false
            const req = mod.request({
                protocol: u.protocol, hostname: host, port: u.port || undefined,
                path: `${u.pathname}${u.search}`, method: reqMethod, headers: reqHeaders,
                agent: u.protocol === 'https:' ? pool.https : pool.http,
            }, (res) => {
                responded = true
                phase = 'body'
                const status = res.statusCode || 0
                const location = res.headers.location
                if (status >= 300 && status < 400 && location && redirect !== 'manual') {
                    res.resume()
                    if (n >= maxHops) return fail('too-many-redirects')
                    let next
                    try { next = new URL(location, u) } catch { return fail('ssrf-blocked') }
                    if (status === 303 || ((status === 301 || status === 302) && reqMethod === 'POST')) {
                        if (reqMethod !== 'HEAD') reqMethod = 'GET'
                        reqBody = undefined
                        reqHeaders = omitHeaders(reqHeaders, ['content-type', 'content-length'])
                    }
                    if (next.origin !== u.origin) {
                        reqHeaders = stripCredentialHeaders(reqHeaders)
                    }
                    phase = 'queued'
                    return hop(next.toString(), n + 1)
                }
                if (discardBody) {
                    res.destroy()
                    return finish(resolve, buildResult(status, res, Buffer.alloc(0)))
                }
                // Probes keep the headers and the first decoded bytes of the body, then drop the socket.
                if (peekBytes > 0) {
                    const peekDecoder = decoderFor(res.headers['content-encoding'])
                    const source = peekDecoder ? res.pipe(peekDecoder) : res
                    const chunks = []
                    let size = 0
                    const settle = () => {
                        res.destroy()
                        finish(resolve, buildResult(status, res, Buffer.concat(chunks).subarray(0, peekBytes)))
                    }
                    peekExpire = settle
                    source.on('data', (chunk) => {
                        chunks.push(chunk)
                        size += chunk.length
                        if (size >= peekBytes) settle()
                    })
                    source.on('end', settle)
                    source.on('error', settle)
                    res.on('error', settle)
                    return
                }
                if (reqMethod !== 'HEAD' && Number(res.headers['content-length']) > maxBytes) return fail('too-large')
                let body = res
                const decoder = decoderFor(res.headers['content-encoding'])
                if (decoder) {
                    decoder.on('error', () => fail('request-failed'))
                    body = res.pipe(decoder)
                }
                const chunks = []
                let size = 0
                body.on('data', (chunk) => {
                    size += chunk.length
                    if (size > maxBytes) { res.destroy(); return fail('too-large') }
                    chunks.push(chunk)
                })
                body.on('error', () => fail('request-failed'))
                res.on('error', () => fail('request-failed'))
                body.on('end', () => finish(resolve, buildResult(status, res, Buffer.concat(chunks))))
            })
            current = req
            req.on('socket', (socket) => {
                if (!socket.connecting) { phase = 'headers'; return }
                // The connect timer starts once the address is known: a slow lookup (the resolver, or the
                // thread pool it shares with zlib and crypto) is a lookup timeout, not a dead host.
                let t = null
                const startConnect = () => {
                    phase = 'connect'
                    t = setTimeout(() => fail('connect-timeout'), connectTimeoutMs)
                }
                if (net.isIP(host)) {
                    startConnect()
                } else {
                    phase = 'lookup'
                    t = setTimeout(() => fail('dns-failed', 'dns-timeout'), connectTimeoutMs)
                    socket.once('lookup', () => {
                        if (done) return
                        clearTimeout(t)
                        // Probes time the response from the end of the lookup, so a slow resolver does not eat it.
                        if (clockFromLookup) {
                            clearTimeout(total)
                            total = setTimeout(expire, totalTimeoutMs)
                        }
                        onLookup?.()
                        startConnect()
                    })
                }
                socket.once('connect', () => { clearTimeout(t); phase = 'headers' })
                socket.once('close', () => clearTimeout(t))
            })
            req.on('error', (err) => {
                if (!responded && !retriedStale && req.reusedSocket && STALE_SOCKET_CODES.has(err?.code)) return hop(target, n, true)
                fail(err?.code, err?.transportCode)
            })
            req.end(reqBody)
        }
        hop(url, 0)
    })
}

const WEB_DEFAULT_MAX_BYTES = 25 * 1024 * 1024
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

const withFetchDefaults = (headers) => {
    const given = {}
    for (const [k, v] of new Headers(headers || {})) given[k] = v
    return {
        'user-agent': 'node', 'accept': '*/*', 'accept-language': '*', 'accept-encoding': 'gzip, deflate',
        ...given,
    }
}

const toFetchError = (err) => {
    const code = err?.code
    if (code === 'timeout') return Object.assign(new Error('This operation was aborted'), { name: 'AbortError', code })
    const message = code === 'ssrf-blocked' || code === 'too-large' || code === 'too-many-redirects' ? code : 'fetch failed'
    return Object.assign(new Error(message), { code })
}

// fetch()-shaped wrapper over guardedFetch: resolves a real Response, rejects with an AbortError on
// timeout/abort and a coded error (message never carries the URL) otherwise. The connect-time lookup
// guard replaces validate-then-fetch; use redirect: 'manual' to keep a caller-driven redirect loop.
export async function guardedWebFetch(url, init = {}) {
    const {
        method = 'GET', headers, body, signal, redirect = 'follow', maxBytes = WEB_DEFAULT_MAX_BYTES,
        maxHops = 5, connectTimeoutMs = 10000, totalTimeoutMs = 120000, lookup, allowPrivate,
    } = init
    let r
    try {
        r = await guardedFetch(String(url), {
            method, headers: withFetchDefaults(headers), body, signal, redirect, maxBytes, maxHops,
            connectTimeoutMs, totalTimeoutMs, lookup, defaultHeaders: false,
            ...(allowPrivate ? { allowPrivate } : {}),
        })
    } catch (err) {
        throw toFetchError(err)
    }
    return new Response(NULL_BODY_STATUSES.has(r.status) ? null : r.buffer, { status: r.status, statusText: r.statusText, headers: r.headers })
}

// Same retry policy as resilientFetch, over the guarded transport.
export function guardedResilientFetch(url, options = {}) {
    return resilientFetch(url, { ...options, fetchImpl: guardedWebFetch })
}
