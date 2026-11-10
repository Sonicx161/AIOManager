import { hashApiKey } from '../api-keys.js'
import { forwardedInfo } from '../admin/net.js'

const first = (v) => (Array.isArray(v) ? v[0] : v)

function decodeSegment(raw) {
    if (!raw) return null
    try { return decodeURIComponent(raw) } catch { return raw }
}

// Rate-limit identity must never depend on password correctness: comparing a
// presented password against the warm auth cache here would let a throttled
// caller tell a correct guess (fresh account bucket, 200) from a wrong one
// (429), an online password oracle. Unverified passwords therefore key by IP,
// plus the claimed account id on sync and credential routes so right and wrong
// guesses share one bucket and one 429. Only device credentials, which
// deviceAuthHook cryptographically verifies before the limiter runs, may select
// an account-only bucket; one NAT cannot starve those accounts.
export function rateLimitKey(request) {
    // The Dashboard's forwarded resolver, not request.ip: same trusted-peer and hop
    // rules, but it also rejects short or malformed X-Forwarded-For chains instead
    // of trusting them, so one client cannot spend another's bucket by claiming
    // its address through a proxy topology mismatch.
    const ip = forwardedInfo(request).ip
    const path = (request.url || '').split('?')[0]
    const device = request.deviceAuth?.accountUuid

    // Hydra consumers authenticate by API key and can share one source IP behind a proxy.
    // Only Hydra routes read that header, so no other route lets it pick a bucket.
    if (path.startsWith('/hydra/')) {
        const apiKey = first(request.headers['x-api-key'])
        return apiKey ? `k:${hashApiKey(apiKey)}` : ip
    }

    // The id comes from the URL; the ip part stops a caller who knows the id from
    // spending the owner's bucket from elsewhere. Claimed, never verified.
    if (path.startsWith('/api/sync/')) {
        const id = decodeSegment(path.split('/')[3])
        return id ? `sync:${id}:${ip}` : ip
    }

    if (device) return `acct:${device}`

    // Credential routes take a password or mint a credential: the claimed account is
    // part of the key but never the whole key, and never gated on password validity.
    // ('/api/devices' without the trailing slash falls through to the IP branch.)
    if (path.startsWith('/api/devices/')) {
        const account = first(request.headers['x-sync-user'])
        return account ? `cred:${account}:${ip}` : ip
    }

    return ip
}
