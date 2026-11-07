import { ADMIN_LIMITS } from './config.js'
import { ipPrefix } from './net.js'

const MAX_TRACKED_IPS = 10000
const IDLE_SWEEP_MS = 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 10 * 60 * 1000
// One /24 or /48 adds at most this many failures to the global count, and is locked on its
// own after PREFIX_LOCK_AFTER failures in the window.
const PER_PREFIX_GLOBAL_CAP = 10
const PREFIX_LOCK_AFTER = 30

// Limiter keys are an IPv4 address, 127.0.0.0/8, or an IPv6 /64; the prefix is its /24 or /48.
export const keyPrefix = (key) => ipPrefix(String(key).replace(/\/(8|64)$/, ''))

export const backoffMs = (failures, cap = ADMIN_LIMITS.backoffCapMs) => failures <= 0 ? 0 : Math.min(cap, 1000 * 2 ** (failures - 1))

// Charge-before-check: every attempt is recorded as a failure before the KDF runs and is
// refunded on success, so concurrent guesses cannot race past the counters. One attempt
// per IP may be in flight. State is in memory only: a restart clears every lock. Locked
// entries are never evicted; when every slot is locked a new source fails closed.
export function createLoginLimiter({ limits = ADMIN_LIMITS, maxTracked = MAX_TRACKED_IPS, sweepIntervalMs = SWEEP_INTERVAL_MS } = {}) {
    const ips = new Map()
    let globalFailures = []
    let globalLockedUntil = 0
    const prefixLocks = new Map()

    const entry = (ip, now) => {
        let e = ips.get(ip)
        if (!e) {
            if (ips.size >= maxTracked) sweep(now, true)
            if (ips.size >= maxTracked) return null
            e = { failures: 0, lockedUntil: 0, lockedAt: 0, hard: false, inFlight: false, lastAt: now }
            ips.set(ip, e)
        }
        return e
    }

    // Normal sweeps drop idle unlocked entries; a forced sweep (table full) drops any unlocked
    // entry, oldest first. In-flight and locked entries always stay.
    function sweep(now = Date.now(), force = false) {
        for (const [ip, e] of ips) {
            if (e.inFlight || e.lockedUntil > now) continue
            if (force || now - e.lastAt > IDLE_SWEEP_MS) ips.delete(ip)
            if (force && ips.size < maxTracked * 0.9) break
        }
    }
    const sweepTimer = sweepIntervalMs > 0 ? setInterval(() => sweep(Date.now()), sweepIntervalMs) : null
    sweepTimer?.unref?.()

    const pruneGlobal = (now) => {
        const cutoff = now - limits.globalWindowMs
        if (globalFailures.length && globalFailures[0].at <= cutoff) globalFailures = globalFailures.filter((c) => c.at > cutoff)
        for (const [p, until] of prefixLocks) if (until <= now) prefixLocks.delete(p)
    }

    const prefixCounts = () => {
        const counts = new Map()
        for (const c of globalFailures) counts.set(c.prefix, (counts.get(c.prefix) || 0) + 1)
        return counts
    }
    const globalCount = (counts) => { let n = 0; for (const v of counts.values()) n += Math.min(v, PER_PREFIX_GLOBAL_CAP); return n }

    // exemptGlobal: loopback and allowlisted peers keep their per-IP backoff but are never
    // locked out by the instance-wide lockout, so the operator can always get in.
    function check(ip, now = Date.now(), { exemptGlobal = false, prefix = keyPrefix(ip) } = {}) {
        if (globalLockedUntil > now && !exemptGlobal) return { allowed: false, scope: 'global', retryAfterMs: globalLockedUntil - now }
        const prefixUntil = prefixLocks.get(prefix) || 0
        if (prefixUntil > now && !exemptGlobal) return { allowed: false, scope: 'prefix', retryAfterMs: prefixUntil - now }
        const e = ips.get(ip)
        if (e?.inFlight) return { allowed: false, scope: 'ip', retryAfterMs: 1000 }
        if (e && e.lockedUntil > now) return { allowed: false, scope: e.hard ? 'hard' : 'ip', retryAfterMs: e.lockedUntil - now }
        return { allowed: true }
    }

    function charge(ip, now = Date.now(), opts = {}) {
        const gate = check(ip, now, opts)
        if (!gate.allowed) return { ...gate, charge: null }
        const e = entry(ip, now)
        if (!e) return { allowed: false, scope: 'capacity', retryAfterMs: 60_000, charge: null }
        e.inFlight = true
        e.lastAt = now
        e.failures++
        if (e.failures >= limits.hardLockAfter) {
            e.hard = true
            e.lockedAt = now
            e.lockedUntil = now + limits.hardLockMs
        } else {
            e.lockedUntil = now + backoffMs(e.failures)
        }
        pruneGlobal(now)
        const prefix = opts.prefix || keyPrefix(ip)
        const token = { ip, prefix, at: now, hardLocked: e.hard && e.lockedAt === now }
        globalFailures.push(token)
        const counts = prefixCounts()
        if ((counts.get(prefix) || 0) >= PREFIX_LOCK_AFTER && !prefixLocks.has(prefix)) {
            token.prefixLocked = true
            prefixLocks.set(prefix, now + limits.globalLockMs)
        }
        if (globalCount(counts) >= limits.globalMaxFailures) {
            token.globalLocked = true
            globalLockedUntil = now + limits.globalLockMs
            globalFailures = []
        }
        return { allowed: true, charge: token }
    }

    // Settles a charge. Failure keeps it and reports lock events for the audit log; success
    // refunds it.
    function settle(token, ok) {
        if (!token) return []
        const e = ips.get(token.ip)
        if (e) e.inFlight = false
        if (ok) {
            ips.delete(token.ip)
            globalFailures = globalFailures.filter((c) => c !== token)
            if (token.globalLocked) globalLockedUntil = 0
            if (token.prefixLocked) prefixLocks.delete(token.prefix)
            return []
        }
        const events = []
        if (token.hardLocked && e) events.push({ event: 'login.lock_ip', scope: 'ip', lockedUntil: e.lockedUntil })
        if (token.prefixLocked) events.push({ event: 'login.lock_prefix', scope: 'prefix', lockedUntil: prefixLocks.get(token.prefix) || 0 })
        if (token.globalLocked) events.push({ event: 'login.lock_global', scope: 'global', lockedUntil: globalLockedUntil })
        return events
    }

    const snapshot = (now = Date.now()) => ({
        globalLockedUntil: globalLockedUntil > now ? globalLockedUntil : null,
        globalFailuresInWindow: (pruneGlobal(now), globalFailures.length),
        lockedIps: [...ips.values()].filter((e) => e.lockedUntil > now && e.hard).length,
        lockedPrefixes: [...prefixLocks.values()].filter((u) => u > now).length,
        trackedIps: ips.size,
    })

    return { check, charge, settle, snapshot, sweep, sweepTimer, stop: () => { if (sweepTimer) clearInterval(sweepTimer) } }
}
