import crypto from 'crypto'
import net from 'net'
import { adminAllowIps, proxyHopsAuto, trustProxyHops, trustedProxyCidrs, trustPrivateNetworks } from './config.js'

function expandV6Groups(s) {
    let text = s
    let tail = []
    const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
    if (v4) {
        const o = v4[1].split('.').map(Number)
        tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]]
        text = text.slice(0, -v4[1].length)
        if (!text.endsWith('::')) text = text.slice(0, -1)
    }
    const [head, rest] = text.split('::')
    const h = head ? head.split(':').filter(Boolean) : []
    const t = rest !== undefined && rest ? rest.split(':').filter(Boolean) : []
    const fill = text.includes('::') ? Array(Math.max(0, 8 - tail.length - h.length - t.length)).fill('0') : []
    return [...h, ...fill, ...t].map((g) => parseInt(g, 16)).concat(tail).slice(0, 8)
}

function compressV6(groups) {
    let best = { at: -1, len: 0 }
    for (let i = 0; i < 8;) {
        if (groups[i] !== 0) { i++; continue }
        let j = i
        while (j < 8 && groups[j] === 0) j++
        if (j - i > best.len) best = { at: i, len: j - i }
        i = j
    }
    const hex = groups.map((g) => g.toString(16))
    if (best.len < 2) return hex.join(':')
    return `${hex.slice(0, best.at).join(':')}::${hex.slice(best.at + best.len).join(':')}`
}

// One spelling per address: brackets and zone ids dropped, IPv4-mapped IPv6 as IPv4,
// IPv6 lower-case and compressed (RFC 5952), so limiter keys and prefixes cannot be split.
export function canonicalIp(raw) {
    if (!raw) return ''
    let s = String(raw).trim()
    if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'))
    const zone = s.indexOf('%')
    if (zone >= 0) s = s.slice(0, zone)
    const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(s)
    if (v4port) s = v4port[1]
    if (net.isIPv4(s)) return s
    if (!net.isIPv6(s)) return s.toLowerCase()
    const g = expandV6Groups(s.toLowerCase())
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`
    return compressV6(g)
}

const normalize = canonicalIp

// Forwarded entries must be plain addresses (optionally ip:port or [v6]:port): junk after a
// closing bracket and zone ids have no honest producer, so those spellings are blanked and
// the chain is rejected like any other malformed token.
const chainIp = (raw) => {
    const s = String(raw).trim()
    if (s.includes('%')) return ''
    if (s.startsWith('[')) {
        const close = s.indexOf(']')
        if (close >= 0 && !/^(:\d{1,5})?$/.test(s.slice(close + 1))) return ''
    }
    return normalize(s)
}

// Limiter bucket: an IPv4 address, or the /64 of an IPv6 address (one subscriber's prefix).
// All of 127/8 is one bucket, so a forwarded 127.0.0.N cannot rotate into fresh buckets.
export function limiterKey(ip) {
    const c = canonicalIp(ip)
    if (net.isIPv4(c) && /^127\./.test(c)) return '127.0.0.0/8'
    if (!net.isIPv6(c)) return c || 'unknown'
    return `${compressV6([...expandV6Groups(c).slice(0, 4), 0, 0, 0, 0])}/64`
}

const headerList = (value) => String(Array.isArray(value) ? value.join(',') : value || '').split(',').map((s) => s.trim()).filter(Boolean)

let trustedCache = { raw: null, list: null }
// Zero-setup proxy trust: loopback, private and Docker network peers are trusted
// proxies, and so are Cloudflare's published ranges (built in below), so Cloudflare direct
// and Cloudflare in front of a local nginx or Traefik work with no setting. TRUSTED_PROXY_CIDRS
// adds further ranges to that automatic trust, so pinning another public proxy never untrusts
// the automatic ones: the forwarded chain is walked past every trusted hop to the real client.
// TRUST_PRIVATE_NETWORKS=false turns the automatic private/loopback trust off for networks
// that host untrusted clients; only Cloudflare and TRUSTED_PROXY_CIDRS then count.
// CF-Connecting-IP is deliberately not read: Cloudflare appends the same client address to
// X-Forwarded-For, so one address-checked walk serves every proxy uniformly and there is no
// second header path whose trust rules could drift.
export function isTrustedProxy(peer) {
    if (!net.isIP(peer)) return false
    if (trustPrivateNetworks() && isPrivateOrLoopback(peer)) return true
    if (isCloudflare(peer)) return true
    const cidrs = trustedProxyCidrs()
    if (!cidrs.length) return false
    const raw = cidrs.join(',')
    if (trustedCache.raw !== raw) trustedCache = { raw, list: compileAllowlist(cidrs).list }
    return trustedCache.list.check(peer, net.isIPv4(peer) ? 'ipv4' : 'ipv6')
}

// Forwarded headers count only from a trusted socket peer: with TRUST_PROXY_HOPS=N the chain
// must hold at least N entries and the client is the entry N hops from the right; in auto
// mode the client is the rightmost untrusted address. X-Forwarded-For entries are walked
// from the socket peer right to left past every trusted proxy (loopback, private range,
// Cloudflare or TRUSTED_PROXY_CIDRS), so a chain of trusted proxies, like a Cloudflare edge,
// loopback cloudflared and Docker-network Traefik, resolves to the real client instead of
// the nearest proxy. The first untrusted entry is the client, so entries a public client
// prepends are never reached; when every entry is trusted the leftmost entry is the client.
// untrustedStop records where the walk stopped so the proxy-trust warning can name an
// unrecognised intermediate proxy (forwardedLeft means entries exist to its left).
// Otherwise the socket peer is the client and X-Forwarded-Proto/Host are ignored. Not
// request.ip: Fastify's trustProxy callback shares this topology but accepts a short or
// malformed chain, while this helper falls back to the peer instead of trusting it.
export function forwardedInfo(request) {
    if (request.adminForwarded) return request.adminForwarded
    const peer = normalize(request.raw?.socket?.remoteAddress) || 'unknown'
    const present = Boolean(request.headers['x-forwarded-for'] || request.headers['x-forwarded-proto'] || request.headers['x-forwarded-host'])
    let info = { ip: peer, peer, trusted: false, present, error: null, untrustedStop: null, forwardedLeft: false }
    if (!isTrustedProxy(peer)) {
        // Untrusted peer: it is the client, whatever forwarded headers it sends.
    } else if (proxyHopsAuto()) {
        if (!request.headers['x-forwarded-for']) {
            // A trusted proxy that forwards only proto/host: it is the client's own proxy.
            if (present) info = { ...info, trusted: true }
        } else {
            const chain = headerList(request.headers['x-forwarded-for']).map(chainIp)
            // The candidate and every entry right of it were written by trusted proxies, so all of
            // them must be IP addresses; entries further left are client-supplied and ignored.
            let client = null
            let bad = false
            let stop = -1
            for (let i = chain.length - 1; i >= 0; i--) {
                const entry = chain[i]
                if (!net.isIP(entry)) { bad = true; break }
                if (!isTrustedProxy(entry)) { client = entry; stop = i; break }
            }
            if (bad) info = { ...info, error: 'bad-chain' }
            else if (client) info = { ...info, ip: client, trusted: true, untrustedStop: client, forwardedLeft: stop > 0 }
            else if (chain.length) info = { ...info, ip: chain[0], trusted: true }
            else info = { ...info, error: 'short-chain' }
        }
    } else {
        const hops = trustProxyHops()
        if (hops) {
            const chain = headerList(request.headers['x-forwarded-for']).map(chainIp)
            const tail = chain.length >= hops ? chain.slice(chain.length - hops) : null
            if (!tail) info = { ...info, error: 'short-chain' }
            else if (!tail.every((e) => net.isIP(e))) info = { ...info, error: 'bad-chain' }
            else info = { ...info, ip: tail[0], trusted: true }
        }
    }
    if (request.raw) request.adminForwarded = info
    return info
}

export const adminClientIp = (request) => forwardedInfo(request).ip

// Fastify's trustProxy, so request.ip (rate limits, logs) follows the same client as the
// Dashboard. Fastify ignores a bare hop count, so the count is applied here behind a trusted
// socket peer. Auto mode is the same rightmost-untrusted walk as forwardedInfo: proxy-addr
// starts at the socket and keeps walking while this callback trusts the address, so
// trusting exactly the trusted proxies yields the first untrusted entry (the client) as
// request.ip, or the leftmost entry when the whole chain is trusted. TRUST_PROXY=true must
// never become Fastify's bare `true`: that honors X-Forwarded-For from any direct peer, so
// a public client could claim any address, drain other clients' rate-limit buckets and
// forge logs. Other public-address proxies are pinned with TRUSTED_PROXY_CIDRS, exactly
// as the Dashboard does; Cloudflare's published ranges are trusted built in.
export function fastifyTrustProxy() {
    if (proxyHopsAuto()) return (addr) => isTrustedProxy(normalize(addr))
    const hops = trustProxyHops()
    if (!hops) return false
    return (addr, i) => i < hops && (i > 0 || isTrustedProxy(normalize(addr)))
}

// Loopback privileges (plain HTTP, lockout exemption) only for a loopback socket peer whose
// request carries no forwarded headers; a forwarded candidate is never trusted as loopback.
export function isDirectLoopback(request) {
    const f = forwardedInfo(request)
    return !f.present && !f.trusted && isLoopback(f.peer)
}

export function forwardedHost(request) {
    if (!forwardedInfo(request).trusted) return null
    const hosts = headerList(request.headers['x-forwarded-host'])
    return hosts.length ? hosts[hosts.length - 1].toLowerCase() : null
}

export function isLoopback(ip) {
    return ip === '127.0.0.1' || ip === '::1' || /^127\./.test(ip)
}

const PRIVATE_RANGES = (() => {
    const list = new net.BlockList()
    list.addSubnet('127.0.0.0', 8, 'ipv4')
    list.addSubnet('10.0.0.0', 8, 'ipv4')
    list.addSubnet('172.16.0.0', 12, 'ipv4')
    list.addSubnet('192.168.0.0', 16, 'ipv4')
    list.addAddress('::1', 'ipv6')
    list.addSubnet('fc00::', 7, 'ipv6')
    list.addSubnet('fe80::', 10, 'ipv6')
    return list
})()

export function isPrivateOrLoopback(ip) {
    const family = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null
    return Boolean(family) && PRIVATE_RANGES.check(ip, family)
}

// Cloudflare's published proxy ranges, copied from https://www.cloudflare.com/ips-v4 and
// https://www.cloudflare.com/ips-v6: recognising them built in makes a Cloudflare-fronted
// instance zero-setup. Refresh this list only when Cloudflare publishes new ranges.
const CLOUDFLARE_PROXY_RANGES = (() => {
    const list = new net.BlockList()
    for (const cidr of [
        // https://www.cloudflare.com/ips-v4
        '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
        '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
        '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
        '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
        // https://www.cloudflare.com/ips-v6
        '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
        '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
    ]) {
        const [addr, bits] = cidr.split('/')
        list.addSubnet(addr, Number(bits), net.isIPv4(addr) ? 'ipv4' : 'ipv6')
    }
    return list
})()

export function isCloudflare(ip) {
    const family = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null
    return Boolean(family) && CLOUDFLARE_PROXY_RANGES.check(ip, family)
}

export function isSecureRequest(request) {
    if (request.raw?.socket?.encrypted) return true
    if (!forwardedInfo(request).trusted) return false
    const proto = headerList(request.headers['x-forwarded-proto']).map((s) => s.toLowerCase())
    return proto.length > 0 && proto[proto.length - 1] === 'https'
}

export function ipPrefix(ip) {
    const c = canonicalIp(ip)
    if (net.isIPv4(c)) return c.split('.').slice(0, 3).join('.') + '.0/24'
    if (net.isIPv6(c)) return `${compressV6([...expandV6Groups(c).slice(0, 3), 0, 0, 0, 0, 0])}/48`
    return 'unknown'
}

export const uaHash = (ua) => crypto.createHash('sha256').update(String(ua || '')).digest('hex').slice(0, 16)

export function uaFamily(ua) {
    const s = String(ua || '')
    if (/Edg\//.test(s)) return 'Edge'
    if (/Firefox\//.test(s)) return 'Firefox'
    if (/Chrome\//.test(s)) return 'Chrome'
    if (/Safari\//.test(s)) return 'Safari'
    if (/^curl\//i.test(s)) return 'curl'
    return s ? 'Other' : 'Unknown'
}

let allowCache = { raw: null, list: null, invalid: [] }

export function compileAllowlist(entries) {
    const list = new net.BlockList()
    const invalid = []
    for (const entry of entries) {
        const [addr, bits] = entry.split('/')
        const family = net.isIPv4(addr) ? 'ipv4' : net.isIPv6(addr) ? 'ipv6' : null
        if (!family) { invalid.push(entry); continue }
        if (bits === undefined) { list.addAddress(addr, family); continue }
        const prefix = Number(bits)
        const max = family === 'ipv4' ? 32 : 128
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) { invalid.push(entry); continue }
        list.addSubnet(addr, prefix, family)
    }
    return { list, invalid }
}

// Empty ADMIN_ALLOW_IPS allows everyone; a configured list that parses to nothing denies everyone.
export function isAllowedIp(ip) {
    const entries = adminAllowIps()
    if (!entries.length) return true
    const raw = entries.join(',')
    if (allowCache.raw !== raw) allowCache = { raw, ...compileAllowlist(entries) }
    if (!net.isIP(ip)) return false
    return allowCache.list.check(ip, net.isIPv4(ip) ? 'ipv4' : 'ipv6')
}

export const allowlistProblems = () => {
    const entries = adminAllowIps()
    return entries.length ? compileAllowlist(entries).invalid : []
}
