// Last-pass safety net for text destined for the clipboard (support copy,
// diagnostics, error reports). This is NOT the privacy mechanism: callers must
// build output from known-safe structured fields. This module only catches
// strays, and it fails closed: unknown URLs and paths collapse to shape
// placeholders, credential-ish values are masked whatever their length, and
// hosts, emails, and identifier strings are removed.
//
// Query/hash tail stripping and the URL collapse are derived from T3 Code
// (apps/web/src/lib/bootError.ts, redact()), MIT License,
// Copyright (c) 2026 T3 Tools Inc.

const ASSET_FRAME_RE = /\b[a-z][\w+.-]*:\/\/[^\s'"<>()]*?\/assets\/([A-Za-z0-9._%-]+\.js)(:\d+:\d+)?/gi
const BARE_ASSET_FRAME_RE = /\/assets\/([A-Za-z0-9._%-]+\.js)(:\d+:\d+)?/g
const PERCENT_URL_RE = /https?%3A%2F%2F[^\s'"<>()]+/gi
const URL_RE = /\b[a-z][\w+.-]*:\/\/[^\s'"<>()]+/gi
const PROTOCOL_RELATIVE_RE = /(?<=[\s('"<>])\/\/[A-Za-z0-9.-]+\.[a-z]{2,}[^\s'"<>()]*/g
const RELATIVE_OPAQUE_PATH_RE = /(?<=[\s('"<>])\/[A-Za-z0-9_\-=%+~]{12,}(?:\/[^\s'"<>()]*)?/g
const QUERY_HASH_TAIL_RE = /[?#][^\s'"()]+/g
const QUOTED_JSON_PAIR_RE = /"([^"\n]{0,48})"\s*:\s*"([^"\n]*)"/g
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const IPV4_RE = /(?<![/\w.])\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b(?![\w.])/g
const IPV6_BRACKET_RE = /\[[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}\]/gi
const HOSTNAME_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi
const BEARER_RE = /\bBearer\s+\S+/gi
const SECRET_PAIR_RE = /\b((?:api|access|refresh|auth|client|session)[_-]?)?(password|passwd|passphrase|pass|token|secret|apikey|api[_-]?key|authorization|jwt|credentials?|cred|session(?:[_-]?id)?|sync(?:[ _-]?id)|user(?:[_-]?(?:id|name))?|account(?:[ _-]?id)?|signature|sig)\b([ \t]*[=:][ \t]*)("[^"\n]*"|'[^'\n]*'|\S+)/gi
const QUOTED_KEY_SENSITIVE = /key|token|secret|pass|auth|sig|jwt|cred|session|sync|user|account|id/i

function shorten(value: string): string {
    return `${value.slice(0, 3)}...${value.slice(-3)}`
}

export function redactCopyText(text: string): string {
    if (!text) return text
    // Real /assets stack frames are the only paths whose shape survives; hold
    // them out so later passes cannot chew on the file names.
    const held: string[] = []
    const hold = (frame: string): string => {
        held.push(frame)
        return `\u0000${held.length - 1}\u0000`
    }
    let out = text
        .replace(ASSET_FRAME_RE, (_m, file: string, loc: string) => hold(`/assets/${file}${loc || ''}`))
        .replace(BARE_ASSET_FRAME_RE, (_m, file: string, loc: string) => hold(`/assets/${file}${loc || ''}`))
        .replace(PERCENT_URL_RE, '[url]')
        .replace(URL_RE, '[path]')
        .replace(PROTOCOL_RELATIVE_RE, '[url]')
        .replace(RELATIVE_OPAQUE_PATH_RE, '[path]')
        .replace(QUERY_HASH_TAIL_RE, '')
        .replace(QUOTED_JSON_PAIR_RE, (match, key: string) => (QUOTED_KEY_SENSITIVE.test(key) ? `"${key}":"***"` : match))
        .replace(EMAIL_RE, '[email]')
        .replace(UUID_RE, '[id]')
        .replace(IPV4_RE, '[host]')
        .replace(IPV6_BRACKET_RE, '[host]')
        .replace(HOSTNAME_RE, '[host]')
        .replace(BEARER_RE, 'Bearer ***')
        .replace(SECRET_PAIR_RE, (match, prefix = '', key = '', separator: string, value: string) => {
            if (value === 'Bearer' || value === 'Basic') return match
            return `${prefix}${key}${separator}***`
        })
    held.forEach((frame, i) => {
        out = out.replaceAll(`\u0000${i}\u0000`, frame)
    })
    return out
}

// Kept for compatibility with earlier callers that used the segment shortener
// directly; display-only, never a privacy guarantee.
export { shorten }
