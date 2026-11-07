import net from 'net'

// One shared address sanitizer for every admin wire boundary. Detection errs toward
// redaction: fullwidth address characters (digits, hex letters, dot, colon, percent)
// fold to their NFKC ASCII forms first, URL hosts resolve through the WHATWG parser
// (0x7f.1, 127.1, 2130706433, octal, percent encoded), dotted quads match anywhere in
// a run (leading zeros, glued hex letters), scheme-less hex or octal alias tokens mask
// whole, hex runs with '::' or five-plus colons
// collapse whole, and %zone-ids go with the address. Ports, timestamps, hashes and
// durations survive untouched; every other character is left byte-identical. Version
// words keep quads only in the default (log) mode: audit text is operator-controlled,
// so it uses strict mode and an extra [ip] there is acceptable. Stored rows are never
// rewritten.
const ADDRESS_CHAR = /[0-9A-Fa-f:.%]/
const DIGIT = /[0-9]/
const ZONE_TAIL = /[A-Za-z0-9._%-]/
const QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const QUAD_PORT = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/
const QUAD_ANYWHERE = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/y
const HEX_IPV4_PART = /^0[xX][0-9A-Fa-f]+$/
const OCTAL_IPV4_PART = /^0[0-9]+$/
// A dotted alias chain or a lone 0x 32-bit number, on non-alphanumeric token
// boundaries, with an optional port. The x in 0x is outside ADDRESS_CHAR, so these
// tokens need their own scan before the linear run scanner.
const ALIAS_CHAIN = /(^|[^0-9A-Za-z])((?:[0-9A-Fa-fxX]{1,10}\.)+[0-9A-Fa-fxX]{1,10}|0[xX][0-9A-Fa-f]{1,8})(:\d{1,5})?(?![0-9A-Za-z])/g
const V6_PORT = /^(.+):(\d{1,5})$/
const VERSION_WORD = /^(?:v|ver|version|build|rev|release)$/i
const VERSION_SEPARATOR = /[\s:=/-]+$/
const TRAILING_WORD = /[A-Za-z]*$/
const CONTEXT = 12
const NON_ASCII = /[^\u0000-\u007f]/
// The NFKC folding for the address alphabet only (U+FF01-FF5E -> ASCII by 0xFEE0), so
// fullwidth digits, hex letters, dots, colons and percents scan as ASCII while every
// other character of the input stays byte-identical.
const FULLWIDTH = /[０-９Ａ-Ｆａ-ｆ．：％]/g
const foldFullwidth = (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
const SCHEME = /\b[a-z][a-z0-9+.-]*:\/\//gi
const SLASHES = /\/\//g
const AUTHORITY_END = /[\s/?#"'<>\\^`{|},;]/
const RELATIVE_PREV = /[\s("'<[{`]/
const PORT_TAIL = /^\d+$/

const octetsInRange = (m) => Number(m[1]) <= 255 && Number(m[2]) <= 255 && Number(m[3]) <= 255 && Number(m[4]) <= 255

// Any embedded dotted quad counts, including quads glued inside longer digit groups
// (999.1.2.3 hides 99.1.2.3), so probe every start position with a sticky regex.
function quadAnywhere(core) {
    for (let k = 0; k < core.length; k++) {
        QUAD_ANYWHERE.lastIndex = k
        const m = QUAD_ANYWHERE.exec(core)
        if (m && octetsInRange(m)) return true
    }
    return false
}

function isVersionContext(recent) {
    const word = TRAILING_WORD.exec(recent.replace(VERSION_SEPARATOR, ''))[0] || ''
    return VERSION_WORD.test(word)
}

// True when the run is exactly a quad plus separators that mark it a version string:
// a version word in recent text, hex letters glued to the quad that complete such a
// word (build, release), or a ':' the run swallowed as the word separator.
function versionQuad(core, recent) {
    let q = QUAD.exec(core)
    if (q && octetsInRange(q) && isVersionContext(recent)) return true
    const glue = /^[A-Fa-f]+/.exec(core)?.[0] ?? ''
    if (glue) {
        let rest = core.slice(glue.length)
        let before = recent + glue
        if (rest.startsWith(':')) { before += ':'; rest = rest.slice(1) }
        q = QUAD.exec(rest)
        const word = TRAILING_WORD.exec(before.replace(VERSION_SEPARATOR, ''))[0] || ''
        if (q && octetsInRange(q) && VERSION_WORD.test(word)) return true
    }
    if (core.startsWith(':')) {
        q = QUAD.exec(core.slice(1))
        if (q && octetsInRange(q) && isVersionContext(`${recent}:`)) return true
    }
    return false
}

// Scheme-less WHATWG IPv4 aliases that are unambiguous: a dotted token with a hex
// (0x..) or octal (0...) part, or a lone 0x 32-bit number, keeps only its port. Bare
// short-form IPv4 like 127.1 is a known, accepted residual in logs because it cannot
// be told apart from decimals; logs only keep allowlisted instance messages.
function aliasPass(s) {
    let out = ''
    let last = 0
    ALIAS_CHAIN.lastIndex = 0
    let m
    while ((m = ALIAS_CHAIN.exec(s))) {
        if (!m[2].split('.').some((p) => HEX_IPV4_PART.test(p) || OCTAL_IPV4_PART.test(p))) continue
        const start = m.index + m[1].length
        out += s.slice(last, start)
        out += `[ip]${m[3] ?? ''}`
        last = start + m[2].length + (m[3] ?? '').length
    }
    return out + s.slice(last)
}

function maskRun(run, recent, strict) {
    const lead = /^\.*/.exec(run)[0]
    const body = run.slice(lead.length)
    const tail = /\.+$/.exec(body)?.[0] ?? ''
    const core = body.slice(0, body.length - tail.length)
    if (!core) return null
    if (core.includes('::') || core.split(':').length - 1 >= 5) {
        if (net.isIP(core) === 6) return `${lead}[ip]${tail}`
        const p = V6_PORT.exec(core)
        if (p && net.isIP(p[1]) === 6) return `${lead}[ip]:${p[2]}${tail}`
        return `${lead}[ip]${tail}`
    }
    let m = QUAD_PORT.exec(core)
    if (m && octetsInRange(m)) return `${lead}[ip]:${m[5]}${tail}`
    if (quadAnywhere(core) && (strict || !versionQuad(core, recent))) return `${lead}[ip]${tail}`
    return null
}

function bracketAddress(s, i) {
    const close = s.indexOf(']', i + 1)
    if (close <= i) return null
    const inner = s.slice(i + 1, close)
    // A %zone-id suffix (raw or %25-encoded) belongs to the address and collapses with it.
    const z = inner.indexOf('%')
    const addr = z === -1 ? inner : inner.slice(0, z)
    const zone = z === -1 ? null : inner.slice(z)
    if (!/^[0-9A-Fa-f:.]+$/.test(addr)) return null
    if (zone && !/^%[A-Za-z0-9._%~-]+$/.test(zone)) return null
    if (!addr.includes(':') && !quadAnywhere(addr)) return null
    let end = close + 1
    let port = ''
    if (s[end] === ':') {
        let k = end + 1
        while (k < s.length && k - end <= 5 && DIGIT.test(s[k])) k++
        if (k > end + 1) port = s.slice(end, k)
        end = k
    }
    return { port, end }
}

// The WHATWG parser canonicalizes URL host spellings (0x7f.1, 127.1, 2130706433, octal
// runs, percent-encoded octets, fullwidth) to a real address, so anything it resolves
// to IPv4 or IPv6 has its host text swapped for [ip], keeping scheme, port and path.
function maskAuthorityHost(token, headLen, parsePrefix) {
    let u
    try { u = new URL(`${parsePrefix}${token}/`) } catch { return token }
    const raw = u.hostname
    if (!raw) return token
    const bare = (raw.startsWith('[') ? raw.slice(1, -1) : raw).split('%')[0]
    if (net.isIP(bare) === 0) return token
    const authority = token.slice(headLen)
    const at = authority.lastIndexOf('@')
    const hostPort = authority.slice(at + 1)
    let hostEnd = hostPort.length
    if (hostPort.startsWith('[')) {
        const close = hostPort.indexOf(']')
        if (close !== -1) hostEnd = close + 1
    } else {
        const colon = hostPort.lastIndexOf(':')
        if (colon !== -1 && PORT_TAIL.test(hostPort.slice(colon + 1))) hostEnd = colon
    }
    return `${token.slice(0, headLen + at + 1)}[ip]${hostPort.slice(hostEnd)}`
}

function urlHostPass(s) {
    const found = []
    SCHEME.lastIndex = 0
    let m
    while ((m = SCHEME.exec(s))) found.push({ start: m.index, headLen: m[0].length, prefix: '' })
    SLASHES.lastIndex = 0
    while ((m = SLASHES.exec(s))) {
        const i = m.index
        if (i !== 0 && !RELATIVE_PREV.test(s[i - 1])) continue
        if (s[i + 2] === '/') continue
        found.push({ start: i, headLen: 2, prefix: 'http:' })
    }
    if (!found.length) return s
    found.sort((a, b) => a.start - b.start)
    let out = ''
    let last = 0
    for (const c of found) {
        if (c.start < last) continue
        let end = c.start + c.headLen
        while (end < s.length && !AUTHORITY_END.test(s[end])) end++
        out += s.slice(last, c.start)
        out += maskAuthorityHost(s.slice(c.start, end), c.headLen, c.prefix)
        last = end
    }
    return out + s.slice(last)
}

export function redactAddresses(input, { strict = false } = {}) {
    let s = String(input ?? '')
    if (NON_ASCII.test(s)) s = s.replace(FULLWIDTH, foldFullwidth)
    s = urlHostPass(s)
    s = aliasPass(s)
    let out = ''
    let i = 0
    while (i < s.length) {
        const ch = s[i]
        if (ch === '[') {
            const hit = bracketAddress(s, i)
            if (hit) {
                out += `[ip]${hit.port}`
                i = hit.end
                continue
            }
        }
        if (ADDRESS_CHAR.test(ch)) {
            let j = i
            while (j < s.length && ADDRESS_CHAR.test(s[j])) j++
            let run = s.slice(i, j)
            // An IPv6 with a %zone-id keeps consuming the zone name so no residue stays.
            const pct = run.indexOf('%')
            if (pct !== -1 && net.isIPv6(run.slice(0, pct))) {
                let k = j
                while (k < s.length && ZONE_TAIL.test(s[k])) k++
                if (k > j) { run = s.slice(i, k); j = k }
            }
            out += maskRun(run, s.slice(Math.max(0, i - CONTEXT), i), strict) ?? run
            i = j
            continue
        }
        out += ch
        i++
    }
    return out
}

// Operator-controlled text (audit wire) uses strict mode: no version-word exemption.
export const redactAddressesStrict = (input) => redactAddresses(input, { strict: true })
