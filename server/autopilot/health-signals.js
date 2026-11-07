// Autopilot host availability: which target a URL is checked on, and what one probe result means.
// Pure: no I/O and no clock. First matching row wins; every verdict names its row.
import { createHash } from 'node:crypto'
import { getDomain } from 'tldts'

export const VERDICT = Object.freeze({ UP: 'UP', DEGRADED: 'DEGRADED', DOWN: 'DOWN', SUSPECT: 'SUSPECT', DEFER: 'DEFER' })
// T: transport or edge-definitive, never confirmed by a manifest read. H: HTTP-level, confirmed once on the trip.
export const STRENGTH = Object.freeze({ T: 'T', H: 'H' })

export const PEEK_BYTES = 512
// Slower than this is up but slow, never a failover by itself.
export const DEGRADED_MS = 4000
const MAX_KEY_LENGTH = 256

// A path segment that may carry per-user config or a secret: it never becomes part of a target key.
const CONFIG_CHARS = /[|=%,{}~.:;@!$&'()*+]/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isConfigSegment = (segment) => segment.length >= 16
    || CONFIG_CHARS.test(segment)
    || UUID.test(segment)
    || (segment.length >= 8 && /[0-9]/.test(segment) && /[a-z]/i.test(segment))

// Known app shapes and the config-free route each one answers. 'manifest' means <prefix>/manifest.json.
export const APP_ROWS = Object.freeze([
    { id: 'stremthru', host: /(^|[.-])stremthru([.-]|$)/i, path: /^((?:\/[^/]+)*?)\/stremio\/(store|wrap|torz|list|sidekick|newz)\//i, probe: '/v0/health' },
    { id: 'aiostreams', host: /aiostreams/i, path: /^((?:\/[^/]+)*?)\/stremio\/[0-9a-f-]{36}\/[^/]+\/manifest\.json$/i, probe: '/api/v1/status' },
    { id: 'aiometadata', host: /aiometadata/i, path: /^((?:\/[^/]+)*?)\/stremio\/[0-9a-f-]{36}\/manifest\.json$/i, probe: '/health' },
    { id: 'comet', host: /(^|[.-])comet([.-]|$)/i, probe: '/health' },
    { id: 'mediafusion', host: /mediafusion/i, probe: '/health' },
    { id: 'torrentio', host: /torrentio/i, probe: 'manifest' },
    { id: 'jackettio', host: /jackettio/i, probe: 'manifest' },
    { id: 'mdblist', host: /mdblist/i, probe: 'manifest' },
    { id: 'aiolists', host: /aiolists/i, probe: 'manifest' },
    { id: 'stremio-official', host: /(^|\.)strem\.io$/i, probe: 'manifest' },
    // Debridio has no config-free route: its own 404 NOT_FOUND on the root means the app answered.
    { id: 'debridio', host: /(^|\.)debridio\.com$/i, probe: '/', appNotFound: /^NOT_FOUND/ },
])

// Over the cap the target falls back to the plain origin root: never a learned route, so a root that 404s
// by design is not read as a dead route.
const withinKeyCap = (target) => (target.key.length <= MAX_KEY_LENGTH ? target
    : { ...target, key: target.origin, probeUrl: target.origin, prefix: '', kind: 'root', learned: false })

// The leading run of segments that cannot carry config: the path an app instance is mounted under.
const mountOf = (segments) => {
    const kept = []
    for (const segment of segments) {
        if (isConfigSegment(segment)) break
        kept.push(segment)
    }
    return kept.length > 0 ? `/${kept.join('/')}` : ''
}

// The liveness target of an addon URL: origin plus the app path prefix, config segments stripped.
export function targetFor(url) {
    let u
    try { u = new URL(String(url)) } catch { return null }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    const origin = u.origin
    const segments = u.pathname.split('/').filter(Boolean)
    if (segments.length > 0 && /^manifest\.json$/i.test(segments[segments.length - 1])) segments.pop()
    const prefix = mountOf(segments)
    const row = APP_ROWS.find(r => r.host.test(u.hostname) || (r.path && r.path.test(u.pathname)))
    if (row) {
        // Fixed app routes live under the instance's mount, so two instances on one host stay two targets.
        const routed = row.path?.exec(u.pathname)
        const mount = routed ? mountOf(routed[1].split('/').filter(Boolean)) : prefix
        const path = row.probe === 'manifest' ? `${prefix}/manifest.json` : `${mount}${row.probe === '/' ? '' : row.probe}`
        const probeUrl = path === '' ? origin : `${origin}${path}`
        const root = row.probe === '/'
        return withinKeyCap({ key: probeUrl, probeUrl, origin, prefix: root ? mount : prefix, app: row.id, kind: root ? 'root' : 'route', learned: !root, appNotFound: row.appNotFound ?? null })
    }
    return withinKeyCap({ key: `${origin}${prefix}`, probeUrl: prefix ? `${origin}${prefix}/` : origin, origin, prefix, app: null, kind: 'root', learned: false, appNotFound: null })
}

// Registrable domain from the Public Suffix List (tldts, ICANN section). Hosting providers' private
// suffixes are not split on purpose: a provider-wide outage stays one domain and cannot look like our egress
// failing. IP literals and single labels are their own domain.
export function registrableDomain(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[(.+)\]$/, '$1').replace(/\.$/, '')
    return getDomain(host) || host
}

const TLS_CODES = new Set([
    'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_REVOKED', 'CERT_UNTRUSTED', 'EPROTO',
])

// Transport results, before any response. retry: in-check retries.
export const TRANSPORT_ROWS = Object.freeze([
    { id: 'dns-transient', match: c => c === 'EAI_AGAIN', verdict: VERDICT.DEFER, resolver: true },
    // A lookup that did not finish in time: the resolver (or our thread pool) is slow, not the host.
    { id: 'dns-timeout', match: c => c === 'dns-timeout', verdict: VERDICT.DEFER, resolver: true },
    // Still waiting for a free socket of our own when the probe timed out: our congestion, not the host.
    { id: 'probe-queued', match: c => c === 'probe-queued', verdict: VERDICT.DEFER },
    { id: 'dns-nxdomain', match: c => c === 'ENOTFOUND' || c === 'dns-failed', verdict: VERDICT.DOWN, strength: STRENGTH.T, retry: 1 },
    { id: 'tls', match: c => TLS_CODES.has(c) || /^ERR_(SSL|TLS)_/.test(c), verdict: VERDICT.DOWN, strength: STRENGTH.T },
    { id: 'connect-refused', match: c => ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'].includes(c), verdict: VERDICT.DOWN, strength: STRENGTH.T, retry: 1 },
    { id: 'connect-reset', match: c => c === 'ECONNRESET' || c === 'EPIPE', verdict: VERDICT.DOWN, strength: STRENGTH.T, retry: 1 },
    { id: 'connect-timeout', match: c => c === 'connect-timeout' || c === 'ETIMEDOUT', verdict: VERDICT.DOWN, strength: STRENGTH.T, retry: 1 },
    // A shared ping that connected but got no response headers in time: a hung app is not up. Only the ping
    // uses this row; any other timeout (a backup read) stays response-timeout and is never down evidence.
    { id: 'ping-timeout', match: c => c === 'ping-timeout', verdict: VERDICT.DOWN, strength: STRENGTH.T, retry: 1 },
    { id: 'response-timeout', match: c => c === 'response-timeout', verdict: VERDICT.SUSPECT, retry: 1 },
    { id: 'blocked', match: c => c === 'ssrf-blocked', verdict: VERDICT.DOWN, strength: STRENGTH.T },
    { id: 'transport-other', match: () => true, verdict: VERDICT.DOWN, strength: STRENGTH.T, retry: 1 },
])

// The most specific code an error carries: the resolver or socket code first, then the guard code.
export const transportCodeOf = (err) => {
    if (err?.name === 'AbortError' || err?.code === 'timeout') return 'response-timeout'
    const native = err?.transportCode
    if (typeof native === 'string' && native) return native
    return typeof err?.code === 'string' ? err.code : 'unknown'
}

const counts = new Map()
const hit = (row) => {
    counts.set(row.id, (counts.get(row.id) || 0) + 1)
    return row
}
// Per-row hit counts since the last call, for one summary line per cycle.
export const takeSignalCounts = () => {
    const out = Object.fromEntries(counts)
    counts.clear()
    return out
}

export function classifyTransport(err) {
    const code = transportCodeOf(err)
    const row = hit(TRANSPORT_ROWS.find(r => r.match(code)))
    return { verdict: row.verdict, strength: row.strength ?? null, row: row.id, transport: true, retry: row.retry ?? 0, resolver: !!row.resolver }
}

const isUpStatus = (status) => (status >= 200 && status < 400) || status === 401 || status === 403 || status === 405
const looksLikeJson = (peek) => /^\s*[[{]/.test(peek)
const looksLikeApp = (r) => looksLikeJson(r.peek) || !!r.header('x-powered-by') || /Cannot GET/.test(r.peek)

// "No app here" answers from PaaS edges, captured live on 2026-10-30 (Vercel, Railway, Render, Heroku,
// Netlify): the platform has nothing deployed behind this host, whatever the body says (Railway's is JSON).
const PAAS_NO_APP = [
    r => r.status === 404 && r.header('x-vercel-error') === 'DEPLOYMENT_NOT_FOUND',
    r => r.status === 404 && r.header('x-railway-fallback') === 'true',
    r => r.status === 404 && r.header('x-render-routing') === 'no-server',
    r => r.status === 404 && /heroku/i.test(r.header('server') || '') && /<title>No such app<\/title>/i.test(r.peek),
    r => r.status === 404 && /netlify/i.test(r.header('server') || '') && /^Not Found - Request ID:/.test(r.peek),
]
export const isPaasNoApp = (r) => PAAS_NO_APP.some(match => match(r))

// What an answer looks like without per-request noise (ids, counters): equal fingerprints are the same page.
export function responseFingerprint({ status, header, peek }) {
    const h = header ?? (() => null)
    const body = String(peek ?? '').replace(/[A-Za-z0-9:_-]{16,}/g, '#').replace(/\d+/g, '0')
    return createHash('sha1').update(`${status}\n${h('content-type') || ''}\n${h('server') || ''}\n${body}`).digest('hex').slice(0, 16)
}

// One HTTP response. r: { status, header(name), peek, responseMs, crossSite, target }.
export const SIGNAL_ROWS = Object.freeze([
    { id: 'cf-challenge', match: r => (r.header('cf-mitigated') || '').toLowerCase() === 'challenge', verdict: VERDICT.DEFER },
    { id: 'rate-limited', match: r => r.status === 429 || /error code: 1015\b/i.test(r.peek), verdict: VERDICT.DEFER },
    { id: 'paas-no-app', match: isPaasNoApp, verdict: VERDICT.DOWN, strength: STRENGTH.T },
    { id: 'cf-tunnel', match: r => r.status === 530 || (r.status >= 500 && /error code: 10(33|16)\b/i.test(r.peek)), verdict: VERDICT.DOWN, strength: STRENGTH.T },
    { id: 'cf-edge', match: r => r.status >= 521 && r.status <= 524, verdict: VERDICT.DOWN, strength: STRENGTH.T },
    { id: 'cf-origin-tls', match: r => r.status === 525 || r.status === 526, verdict: VERDICT.DOWN, strength: STRENGTH.H },
    { id: 'gateway', match: r => r.status === 502 || r.status === 503 || r.status === 504, verdict: VERDICT.DOWN, strength: STRENGTH.H },
    { id: 'traefik-404', match: r => r.status === 404 && r.peek.trim() === '404 page not found' && /text\/plain/i.test(r.header('content-type') || ''), verdict: VERDICT.DOWN, strength: STRENGTH.H },
    { id: 'app-not-found', match: r => r.status === 404 && !!r.target?.appNotFound?.test(r.peek), verdict: VERDICT.UP },
    { id: 'route-gone', match: r => (r.status === 404 || r.status === 410) && !!r.target?.learned, verdict: VERDICT.DOWN, strength: STRENGTH.H },
    { id: 'root-404-app', match: r => r.status === 404 && looksLikeApp(r), verdict: VERDICT.UP },
    { id: 'root-404', match: r => r.status === 404 || r.status === 410, verdict: VERDICT.SUSPECT },
    { id: 'cross-site-redirect', match: r => r.status >= 300 && r.status < 400 && !!r.crossSite, verdict: VERDICT.SUSPECT },
    { id: 'server-error', match: r => r.status >= 500, verdict: VERDICT.SUSPECT },
    { id: 'caddy-empty-200', match: r => r.status === 200 && r.peek === '' && /caddy/i.test(r.header('server') || ''), verdict: VERDICT.SUSPECT },
    { id: 'proxy-default-page', match: r => r.status === 200 && /Congratulations!/.test(r.peek) && /openresty|nginx/i.test(r.header('server') || ''), verdict: VERDICT.SUSPECT },
    { id: 'up-slow', match: r => isUpStatus(r.status) && (r.responseMs ?? 0) > DEGRADED_MS, verdict: VERDICT.DEGRADED },
    { id: 'up', match: r => isUpStatus(r.status), verdict: VERDICT.UP },
    { id: 'unmatched', match: () => true, verdict: VERDICT.SUSPECT },
])

export function classifyResponse(r) {
    const input = { peek: '', ...r, header: r.header ?? (() => null) }
    const row = hit(SIGNAL_ROWS.find(s => s.match(input)))
    return { verdict: row.verdict, strength: row.strength ?? null, row: row.id, transport: false }
}

// A manifest read as host evidence only. 'down': transport or edge-level failure. 'app': the app answered
// (200 JSON with an id, or the app's own JSON error, which is a config problem). 'defer': rate limited or
// challenged. 'inconclusive': anything else, including a proxy 404 on a user URL and a timeout.
export function classifyManifestRead(outcome) {
    if (outcome?.error) {
        const t = classifyTransport(outcome.error)
        if (t.verdict === VERDICT.DOWN) return 'down'
        if (t.verdict === VERDICT.DEFER) return 'defer'
        return 'inconclusive'
    }
    const status = outcome?.status ?? 0
    const header = outcome?.header ?? (() => null)
    const body = outcome?.peek ?? ''
    if ((header('cf-mitigated') || '').toLowerCase() === 'challenge' || status === 429) return 'defer'
    if (isPaasNoApp({ status, header, peek: body })) return 'down'
    if (status === 530 || (status >= 521 && status <= 526)) return 'down'
    if (status >= 200 && status < 300) return outcome?.manifestId ? 'app' : 'inconclusive'
    // JSON from the app below 500 is the app answering (a config error); a JSON 5xx is the server not serving.
    if (status < 500 && looksLikeJson(body)) return 'app'
    if (status === 502 || status === 503 || status === 504) return 'down'
    return 'inconclusive'
}
