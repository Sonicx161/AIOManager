import crypto from 'crypto'
import { PRIMARY_KEY } from '../keys.js'

// Signed "known device" cookie set on a successful sign-in. It only exempts its holder from
// the instance-wide (and per-prefix) lockout so the operator can get back in during an
// attack; per-IP backoff and the password check still apply. The HMAC key is derived from
// the encryption key, the username and this instance's stored password hash (unique salt), so
// a cookie never verifies on another instance sharing ENCRYPTION_KEY, nor after either changes.
// No new secret is stored.
export const DEVICE_COOKIE = 'aiom_admin_device'
export const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000

const key = (credential) => crypto.createHash('sha256').update(`aiom-dashboard-known-device|${PRIMARY_KEY || ''}|${credential}`).digest()
const mac = (payload, credential) => crypto.createHmac('sha256', key(credential)).update(payload).digest('base64url')

export function issueDeviceToken(credential, { now = Date.now(), remembered = false } = {}) {
    const payload = `v1.${now}.${crypto.randomBytes(12).toString('base64url')}${remembered ? '.r' : ''}`
    return `${payload}.${mac(payload, credential)}`
}

// Returns null for anything malformed, stale or signed for another credential; a valid
// token reports whether its sign-in asked to be remembered ('.r' flag segment).
function parseDeviceToken(token, credential, now = Date.now()) {
    if (typeof credential !== 'string' || !credential) return null
    if (typeof token !== 'string' || token.length > 200) return null
    const parts = token.split('.')
    if (![4, 5].includes(parts.length) || parts[0] !== 'v1') return null
    if (parts.length === 5 && parts[3] !== 'r') return null
    const issued = Number(parts[1])
    if (!Number.isSafeInteger(issued) || issued > now + 60_000 || now - issued > DEVICE_TTL_MS) return null
    const payload = parts.slice(0, -1).join('.')
    const expected = Buffer.from(mac(payload, credential))
    const given = Buffer.from(parts[parts.length - 1])
    if (!(expected.length === given.length && crypto.timingSafeEqual(expected, given))) return null
    return { remembered: parts.length === 5 }
}

export function verifyDeviceToken(token, credential, now = Date.now()) {
    return parseDeviceToken(token, credential, now) !== null
}

export function verifyRememberedDeviceToken(token, credential, now = Date.now()) {
    return parseDeviceToken(token, credential, now)?.remembered === true
}

export const deviceCookieHeader = (secure, token) =>
    `${DEVICE_COOKIE}=${token}; Path=/api/admin; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Max-Age=${Math.floor(DEVICE_TTL_MS / 1000)}`
