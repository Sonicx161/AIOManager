import crypto from 'crypto'
import db from '../db.js'
import { isReadOnlyReplica } from '../config.js'
import { ADMIN_LIMITS } from './config.js'

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
export const hashSessionId = (id) => sha256(`aiom-admin-session:${id}`)
export const csrfForSession = (id) => crypto.createHmac('sha256', String(id)).update('aiom-admin-csrf').digest('base64url')
export const sessionHandle = (idHash) => String(idHash).slice(0, 16)

// last_seen_at is held here and written at most once a minute.
const lastSeen = new Map()
// The newest last_seen_at write per session, reserved before the write is awaited so
// concurrent requests coalesce into one write per minute.
const persistedAt = new Map()

const toRow = (r) => r && ({
    idHash: r.id_hash,
    createdAt: Number(r.created_at),
    lastSeenAt: Number(r.last_seen_at),
    expiresAt: Number(r.expires_at),
    ipPrefix: r.ip_prefix,
    uaFamily: r.ua_family,
    uaHash: r.ua_hash,
    remembered: Number(r.remembered) === 1,
})

export function createSessionStore({ limits = ADMIN_LIMITS } = {}) {
    // A remembered browser ("Remember this browser") gets a 30-day absolute lifetime
    // with a 7-day sliding idle window; every other session keeps the short pair.
    // Custom limits objects may omit the remembered pair, so default both here.
    const rememberedIdleMs = limits.rememberedSessionIdleMs ?? 7 * 24 * 60 * 60 * 1000
    const rememberedAbsoluteMs = limits.rememberedSessionAbsoluteMs ?? 30 * 24 * 60 * 60 * 1000
    const idleMsFor = (remembered) => (remembered ? rememberedIdleMs : limits.sessionIdleMs)
    const absoluteMsFor = (remembered) => (remembered ? rememberedAbsoluteMs : limits.sessionAbsoluteMs)
    const idleExpiry = (row) => Math.min(row.expiresAt, row.lastSeenAt + idleMsFor(row.remembered))
    const SESSION_COLS = 'id_hash, created_at, last_seen_at, expires_at, ip_prefix, ua_hash, ua_family, remembered'

    // Creation is serialized in process (the Dashboard is single-process and off on replicas):
    // insert, then trim the least recently seen (then oldest created, then id_hash) down to
    // the cap, never the session just created, so an active main tab is never evicted. created_at is kept strictly increasing so "oldest" is
    // the earliest sign-in even within one millisecond.
    let createChain = Promise.resolve()
    let lastCreatedAt = 0
    function create(input) {
        const run = () => createLocked(input)
        const next = createChain.then(run, run)
        createChain = next.catch(() => {})
        return next
    }

    async function createLocked({ ipPrefix, uaHash, uaFamily, remembered = false, now = Date.now() }) {
        const createdAt = Math.max(now, lastCreatedAt + 1)
        lastCreatedAt = createdAt
        const id = crypto.randomBytes(32).toString('base64url')
        const idHash = hashSessionId(id)
        const row = { id_hash: idHash, created_at: createdAt, last_seen_at: now, expires_at: now + absoluteMsFor(remembered), ip_prefix: ipPrefix, ua_hash: uaHash, ua_family: uaFamily, remembered: remembered ? 1 : 0 }
        // The idle half of the sweep must use each row's own idle window, or every
        // remembered session would be swept after 30 minutes. ($N params are unique:
        // the db layer binds them positionally.)
        await db.run(
            'DELETE FROM admin_sessions WHERE expires_at <= $1 OR last_seen_at + (CASE WHEN remembered = 1 THEN $2 ELSE $3 END) + $4 <= $5',
            [now, rememberedIdleMs, limits.sessionIdleMs, limits.lastSeenWriteMs, now]
        )
        await db.run(
            'INSERT INTO admin_sessions (id_hash, created_at, last_seen_at, expires_at, ip_prefix, ua_hash, ua_family, remembered) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [row.id_hash, row.created_at, row.last_seen_at, row.expires_at, row.ip_prefix, row.ua_hash, row.ua_family, row.remembered]
        )
        const others = await db.query('SELECT id_hash FROM admin_sessions WHERE id_hash <> $1 ORDER BY last_seen_at ASC, created_at ASC, id_hash ASC', [idHash])
        const excess = others.length + 1 - limits.maxSessions
        for (const stale of others.slice(0, Math.max(0, excess))) {
            lastSeen.delete(stale.id_hash)
            persistedAt.delete(stale.id_hash)
            await db.run('DELETE FROM admin_sessions WHERE id_hash = $1', [stale.id_hash])
        }
        lastSeen.set(idHash, now)
        return { id, idHash, csrf: csrfForSession(id), expiresAt: row.expires_at, idleExpiresAt: now + idleMsFor(remembered), remembered }
    }

    async function load(idHash) {
        return toRow(await db.get(`SELECT ${SESSION_COLS} FROM admin_sessions WHERE id_hash = $1`, [idHash]))
    }

    // Validates and, unless touch is false, counts as activity. Returns null for unknown,
    // idle-expired or absolute-expired ids. A replica never writes: an expired session
    // reads as signed out without the DELETE; the primary keeps the expiry cleanup.
    async function validate(id, now = Date.now(), { touch = true } = {}) {
        if (typeof id !== 'string' || id.length < 32 || id.length > 128) return null
        const idHash = hashSessionId(id)
        const row = await load(idHash)
        if (!row) { lastSeen.delete(idHash); persistedAt.delete(idHash); return null }
        const writtenAt = row.lastSeenAt
        row.lastSeenAt = Math.max(row.lastSeenAt, lastSeen.get(idHash) || 0)
        if (now >= row.expiresAt || now >= row.lastSeenAt + idleMsFor(row.remembered)) {
            if (isReadOnlyReplica()) {
                lastSeen.delete(idHash)
                persistedAt.delete(idHash)
            } else {
                await remove(idHash)
            }
            return null
        }
        if (!touch) return { ...row, csrf: csrfForSession(id), idleExpiresAt: idleExpiry(row) }
        if (now - Math.max(writtenAt, persistedAt.get(idHash) || 0) >= limits.lastSeenWriteMs) {
            persistedAt.set(idHash, now)
            await db.run('UPDATE admin_sessions SET last_seen_at = $1 WHERE id_hash = $2', [now, idHash])
        }
        lastSeen.set(idHash, now)
        row.lastSeenAt = now
        return { ...row, csrf: csrfForSession(id), idleExpiresAt: idleExpiry(row) }
    }

    async function remove(idHash) {
        lastSeen.delete(idHash)
        persistedAt.delete(idHash)
        await db.run('DELETE FROM admin_sessions WHERE id_hash = $1', [idHash])
    }

    async function list(now = Date.now()) {
        const rows = (await db.query(`SELECT ${SESSION_COLS} FROM admin_sessions ORDER BY created_at DESC`, [])).map(toRow)
        return rows
            .map((r) => ({ ...r, lastSeenAt: Math.max(r.lastSeenAt, lastSeen.get(r.idHash) || 0) }))
            .filter((r) => now < r.expiresAt && now < r.lastSeenAt + idleMsFor(r.remembered))
    }

    async function removeByHandle(handle) {
        if (!/^[0-9a-f]{16}$/.test(String(handle))) return 0
        const match = (await list()).filter((r) => sessionHandle(r.idHash) === handle)
        for (const r of match) await remove(r.idHash)
        return match.length
    }

    async function removeAll() {
        const count = (await list()).length
        lastSeen.clear()
        persistedAt.clear()
        await db.run('DELETE FROM admin_sessions', [])
        return count
    }

    return { create, validate, remove, list, removeByHandle, removeAll }
}
