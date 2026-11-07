import { isReadOnlyReplica } from '../config.js'

const TRUTHY = ['1', 'true', 'yes', 'on']

// Read live from process.env so tests and the CLIs can toggle them; lib/env.js validates at boot.
export const isAdminEnabled = () => TRUTHY.includes(String(process.env.ADMIN_ENABLED || '').toLowerCase())
export const adminSetupMode = () => String(process.env.ADMIN_SETUP || '').toLowerCase() === 'token' ? 'token' : 'off'
export const adminCredentialsEnv = () => process.env.ADMIN_CREDENTIALS || null
export const adminSecretHashEnv = () => {
    const raw = process.env.ADMIN_SECRET_HASH
    return raw && raw.trim() ? raw.trim() : null
}
export const adminUsernameEnv = () => {
    const raw = process.env.ADMIN_USERNAME
    return raw && raw.trim() ? raw.trim() : null
}
// On unless set to a falsy value: plain HTTP sign-in from private addresses only.
export const adminAllowHttpLan = () => {
    const raw = String(process.env.ADMIN_ALLOW_HTTP_LAN ?? '').trim().toLowerCase()
    return raw === '' || TRUTHY.includes(raw)
}
export const adminAllowIps = () => String(process.env.ADMIN_ALLOW_IPS || '').split(',').map((s) => s.trim()).filter(Boolean)
export const trustedProxyCidrs = () => String(process.env.TRUSTED_PROXY_CIDRS || '').split(',').map((s) => s.trim()).filter(Boolean)
// Unset or "auto": a trusted peer (loopback, private range or TRUSTED_PROXY_CIDRS) that sends
// forwarding headers counts as one proxy. A number pins the hop count; 0 turns proxy trust off.
export const proxyHopsAuto = () => {
    const raw = String(process.env.TRUST_PROXY_HOPS ?? '').trim().toLowerCase()
    return raw === '' || raw === 'auto'
}
export const trustProxyHops = () => {
    if (proxyHopsAuto()) return 0
    const n = Number.parseInt(process.env.TRUST_PROXY_HOPS, 10)
    return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 0
}
export const adminReadOnly = () => isReadOnlyReplica()

export const ADMIN_LIMITS = {
    bodyLimit: 16 * 1024,
    sessionIdleMs: 30 * 60 * 1000,
    sessionAbsoluteMs: 8 * 60 * 60 * 1000,
    rememberedSessionIdleMs: 7 * 24 * 60 * 60 * 1000,
    rememberedSessionAbsoluteMs: 30 * 24 * 60 * 60 * 1000,
    lastSeenWriteMs: 60 * 1000,
    maxSessions: 20,
    backoffCapMs: 15 * 60 * 1000,
    hardLockAfter: 10,
    hardLockMs: 60 * 60 * 1000,
    globalWindowMs: 10 * 60 * 1000,
    globalMaxFailures: 30,
    globalLockMs: 15 * 60 * 1000,
    setupTokenTtlMs: 15 * 60 * 1000,
    minPassphraseLength: 14,
}
