import crypto from 'crypto'
import net from 'net'
import { adminAllowIps, proxyHopsAuto, trustProxyHops, trustedProxyCidrs } from './config.js'

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
// Loopback is always a trusted proxy. TRUSTED_PROXY_CIDRS, when set, replaces the default
// private ranges, so an operator can pin trust to the exact proxy addresses.
export function isTrustedProxy(peer) {
    if (!net.isIP(peer)) return false
    if (isLoopback(peer)) return true
    const cidrs = trustedProxyCidrs()
    if (!cidrs.length) return isPrivateOrLoopback(peer)
    const raw = cidrs.join(',')
    if (trustedCache.raw !== raw) trustedCache = { raw, list: compileAllowlist(cidrs).list }
    return trustedCache.list.check(peer, net.isIPv4(peer) ? 'ipv4' : 'ipv6')
}

// Forwarded headers count only from a trusted socket peer: with TRUST_PROXY_HOPS=N the chain
// must hold at least N entries and the client is the entry N hops from the right; in auto
// mode the peer is one proxy (its X-Forwarded-For entry, or itself when it sends none).
// Otherwise the socket peer is the client and X-Forwarded-Proto/Host are ignored. Never
// request.ip: TRUST_PROXY trusts every hop and lets clients pick an IP.
export function forwardedInfo(request) {
    if (request.adminForwarded) return request.adminForwarded
    const peer = normalize(request.raw?.socket?.remoteAddress) || 'unknown'
    const present = Boolean(request.headers['x-forwarded-for'] || request.headers['x-forwarded-proto'] || request.headers['x-forwarded-host'])
    const auto = proxyHopsAuto()
    const hops = auto ? (present ? 1 : 0) : trustProxyHops()
    let info = { ip: peer, peer, trusted: false, present, error: null }
    if (auto && present && isTrustedProxy(peer) && !request.headers['x-forwarded-for']) {
        info = { ...info, trusted: true }
    } else if (hops && isTrustedProxy(peer)) {
        const chain = headerList(request.headers['x-forwarded-for']).map(normalize)
        // The candidate and every entry right of it were written by trusted proxies, so all of
        // them must be IP addresses; entries further left are client-supplied and ignored.
        const tail = chain.length >= hops ? chain.slice(chain.length - hops) : null
        if (!tail) info = { ...info, error: 'short-chain' }
        else if (!tail.every((e) => net.isIP(e))) info = { ...info, error: 'bad-chain' }
        else info = { ...info, ip: tail[0], trusted: true }
    }
    if (request.raw) request.adminForwarded = info
    return info
}

export const adminClientIp = (request) => forwardedInfo(request).ip

// Fastify's trustProxy, so request.ip (rate limits, logs) follows the same hops as the Dashboard.
// Fastify ignores a bare hop count, so the count is applied here behind a trusted socket peer.
// Auto counts a trusted peer as one proxy, as forwardedInfo does.
export function fastifyTrustProxy() {
    const raw = String(process.env.TRUST_PROXY ?? '').trim().toLowerCase()
    if (raw === 'true' || raw === '1') return true
    const hops = proxyHopsAuto() ? 1 : trustProxyHops()
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
