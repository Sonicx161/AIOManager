// RealStream is a PocketBase-backed sync service (https://realbase.fortheweak.cloud).
// Unlike Nuvio (Supabase + profile_index) it has NO profile concept; addons are scoped
// per user, and there is no bulk "replace all" RPC, so writeAddons is a read-modify-write
// reconcile (create/patch/delete individual records). PocketBase auth also differs from
// Nuvio: auth-refresh extends the CURRENT token (there is no separate refresh token), so
// once a token has fully expired the user must re-authenticate.
const DEFAULT_BASE_URL = 'https://realbase.fortheweak.cloud'

import { guardedResilientFetch } from '../utils/safe-fetch.js'

const AUTH_PATH = '/api/collections/users/auth-with-password'
const REFRESH_PATH = '/api/collections/users/auth-refresh'
const ADDONS_PATH = '/api/collections/addons/records'
const AUTH_TIMEOUT_MS = 30000

// PocketBase auth tokens default to a 14-day lifetime; project as a fallback when the JWT
// can't be decoded.
const DEFAULT_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000

// ── Record model (confirmed against a live RealStream record) ────────────────────────────
// RealStream stores a user's ENTIRE addon collection in ONE PocketBase record:
//   { user: "<userId>", data: [ <addonObject>, ... ] }
// There is no per-addon enabled flag; presence in `data` means installed/enabled, which lines
// up with the reconciler handing us an already enabled-filtered list. Each addon object mirrors
// a Stremio manifest:
//   { manifestUrl, baseUrl, id, manifestId, name, description, logo, background, poster,
//     idPrefixes, resources: string[], types: string[], version, type: 'stremio' }
const USER_FIELD = 'user'
const ADDON_TYPE = 'stremio'

// R2-08: the authorized empty clear is removed for this beta (same reason as the
// client driver: duplicate records and guest-shaped reads make emptiness
// unverifiable), so an empty projection skips with this plain reason instead of
// a false success.
const REALSTREAM_CLEAR_UNSUPPORTED = "RealStream can't be cleared from AIOManager yet; remove the addons in RealStream"

function decodeJwtExpMs(token) {
    try {
        const payload = token.split('.')[1]
        const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        return typeof json.exp === 'number' ? json.exp * 1000 : null
    } catch {
        return null
    }
}

function decodeJwtId(token) {
    try {
        const payload = token.split('.')[1]
        const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        return typeof json.id === 'string' && json.id ? json.id : null
    } catch {
        return null
    }
}

// PocketBase scopes addon records to the authenticated user; a stale stored userId both
// hides records from reads and makes record creation a 400 invalid relation (burner r04),
// so the token's own identity wins whenever it can be read.
export function resolveRealStreamUserId(accessToken, storedUserId) {
    return decodeJwtId(accessToken) || storedUserId
}

function deriveAddonName(url) {
    if (!url) return 'Untitled Addon'
    try {
        const host = new URL(url).hostname.replace(/^www\./, '')
        const first = host.split('.')[0]
        return first.charAt(0).toUpperCase() + first.slice(1) + ' Addon'
    } catch {
        return 'Untitled Addon'
    }
}

function toDescriptor(a) {
    const manifestUrl = a.manifestUrl || (a.baseUrl ? `${a.baseUrl.replace(/\/+$/, '')}/manifest.json` : '')
    return {
        transportUrl: manifestUrl,
        name: a.name || '',
        // Presence in the RealStream collection means enabled.
        flags: { enabled: true },
        manifest: {
            id: a.id || a.manifestId,
            name: a.name,
            version: a.version,
            description: a.description ?? undefined,
            logo: a.logo ?? undefined,
            background: a.background ?? undefined,
            types: Array.isArray(a.types) ? a.types : [],
            resources: Array.isArray(a.resources) ? a.resources : [],
            idPrefixes: a.idPrefixes ?? undefined,
        },
    }
}

function toRecordAddon(addon) {
    const transportUrl = addon.transportUrl || addon.url || ''
    const baseUrl = transportUrl.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '')
    const m = addon.manifest || {}
    // Stremio resources may be strings or { name, ... } objects; RealStream stores plain strings.
    const resources = Array.isArray(m.resources)
        ? m.resources.map(r => (typeof r === 'string' ? r : r?.name)).filter(Boolean)
        : []
    return {
        background: m.background ?? null,
        baseUrl,
        description: m.description ?? null,
        id: m.id || addon.id || null,
        manifestId: m.id || addon.id || null,
        idPrefixes: m.idPrefixes ?? null,
        logo: m.logo ?? null,
        manifestUrl: transportUrl,
        name: m.name || addon.name || deriveAddonName(transportUrl),
        poster: m.poster ?? null,
        resources,
        type: ADDON_TYPE,
        types: Array.isArray(m.types) ? m.types : [],
        version: m.version ?? null,
    }
}

export function createRealStreamDriver(options = {}) {
    const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')

    const makeHeaders = (accessToken) => ({
        'Content-Type': 'application/json',
        ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {})
    })

    const tokenResult = (data) => ({
        accessToken: data.token,
        userId: data.record?.id || null,
        expiresAt: decodeJwtExpMs(data.token) || Date.now() + DEFAULT_TOKEN_TTL_MS
    })

    const request = async (method, path, accessToken, body) => {
        const res = await guardedResilientFetch(`${baseUrl}${path}`, {
            method,
            headers: makeHeaders(accessToken),
            timeout: 15000,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        })
        if (!res.ok) {
            let data = null
            try { data = await res.json() } catch {}
            // PocketBase validation errors carry per-field reasons under `data`:
            // { status, message, data: { <field>: { code, message } } }. Surface the field
            // names so a schema mismatch is diagnosable instead of a generic "Failed to create".
            const fieldErrors = data?.data && typeof data.data === 'object'
                ? Object.entries(data.data).map(([f, v]) => `${f} (${v?.message || v?.code || 'invalid'})`).join(', ')
                : ''
            const detail = fieldErrors
                ? `${data?.message || 'validation failed'}, fields: ${fieldErrors}`
                : (data?.message || data?.error || (data ? JSON.stringify(data) : ''))
            const err = new Error(`RealStream ${method} ${path} returned ${res.status}${detail ? ': ' + detail : ''}`)
            err.status = res.status
            err.isAuthError = res.status === 401 || res.status === 403
            err.data = data
            throw err
        }
        if (res.status === 204) return null
        const text = await res.text()
        if (!text) return null
        try { return JSON.parse(text) } catch { return null }
    }

    const listRecords = async (accessToken, userId) => {
        const filter = encodeURIComponent(`${USER_FIELD}='${userId}'`)
        const data = await request('GET', `${ADDONS_PATH}?filter=${filter}&perPage=1`, accessToken)
        return Array.isArray(data?.items) ? data.items : []
    }

    return {
        capabilities: ['addons'],

        async authenticate(email, password) {
            const res = await guardedResilientFetch(`${baseUrl}${AUTH_PATH}`, {
                method: 'POST',
                headers: makeHeaders(null),
                body: JSON.stringify({ identity: email, password }),
                timeout: AUTH_TIMEOUT_MS,
                retries: 0
            })
            if (!res.ok) {
                const err = new Error(`RealStream auth failed: ${res.status}`)
                err.status = res.status
                err.isAuthError = res.status === 400 || res.status === 401 || res.status === 403
                try { err.data = await res.json() } catch {}
                throw err
            }
            return tokenResult(await res.json())
        },

        async register(email, password, name) {
            const res = await guardedResilientFetch(`${baseUrl}/api/collections/users/records`, {
                method: 'POST',
                headers: makeHeaders(null),
                body: JSON.stringify({ email, password, passwordConfirm: password, name: name || email.split('@')[0] }),
                timeout: AUTH_TIMEOUT_MS,
                retries: 0
            })
            if (!res.ok) {
                let data = null
                try { data = await res.json() } catch {}
                const fieldErrors = data?.data && typeof data.data === 'object'
                    ? Object.entries(data.data).map(([f, v]) => `${f} (${v?.message || v?.code || 'invalid'})`).join(', ')
                    : ''
                const detail = fieldErrors || data?.message || ''
                const err = new Error(`RealStream signup failed: ${res.status}${detail ? ' - ' + detail : ''}`)
                err.status = res.status
                err.isAuthError = res.status === 400
                err.data = data
                throw err
            }
            return this.authenticate(email, password)
        },

        // PocketBase extends the current token; it does NOT use a separate refresh token, so
        // the still-valid access token is what's passed in. A 401/403 here means re-login.
        async refreshAccessToken(accessToken) {
            const res = await guardedResilientFetch(`${baseUrl}${REFRESH_PATH}`, {
                method: 'POST',
                headers: makeHeaders(accessToken),
                timeout: AUTH_TIMEOUT_MS,
                retries: 0
            })
            if (!res.ok) {
                const err = new Error(`RealStream token refresh failed: ${res.status}`)
                err.status = res.status
                err.isAuthError = res.status === 401 || res.status === 403
                throw err
            }
            return tokenResult(await res.json())
        },

        async readAddons(accessToken, userId) {
            if (!userId) throw new Error('RealStream readAddons requires a userId')
            const records = await listRecords(accessToken, resolveRealStreamUserId(accessToken, userId))
            const data = records[0]?.data
            return Array.isArray(data) ? data.map(toDescriptor) : []
        },

        // The whole collection is a single record's `data` array, so a push is a full replace:
        // PATCH the existing record, or POST one if the user has none yet. The reconciler hands
        // us the already enabled-filtered canonical list. R2-08: an empty projection is never
        // a confirmed write (the authorized clear is removed for this beta: duplicate records
        // and guest-shaped reads make emptiness unverifiable), so it skips with a plain
        // reason and zero mutating requests.
        async writeAddons(accessToken, addons, userId) {
            if (!userId) throw new Error('RealStream writeAddons requires a userId')

            const data = (addons || [])
                .filter(a => (a.transportUrl || a.url))
                .map(toRecordAddon)

            if (data.length === 0) {
                const reason = (addons || []).length === 0 ? REALSTREAM_CLEAR_UNSUPPORTED : 'No valid addons to push'
                return { skipped: true, reason }
            }

            const uid = resolveRealStreamUserId(accessToken, userId)
            const records = await listRecords(accessToken, uid)
            const existing = records[0]
            if (existing) {
                return request('PATCH', `${ADDONS_PATH}/${existing.id}`, accessToken, { data })
            }
            return request('POST', ADDONS_PATH, accessToken, { [USER_FIELD]: uid, data })
        }
    }
}
