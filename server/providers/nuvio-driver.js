const DEFAULT_BASE_URL = 'https://api.nuvio.tv'
const DEFAULT_PUBLISHABLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI'
const TOKEN_GRANT_PATH = '/auth/v1/token'
const REST_PATH = '/rest/v1'
const RPC_PATH = `${REST_PATH}/rpc`
const AUTH_TIMEOUT_MS = 30000
const RPC_TIMEOUT_MS = 30000
const REST_TIMEOUT_MS = 15000

import { Buffer } from 'node:buffer'
import { traced } from '../utils/trace.js'
import { guardedResilientFetch, guardedWebFetch } from '../utils/safe-fetch.js'

const BACKUP_EXPORT_MAX_BYTES = 50 * 1024 * 1024
const RPC_DEFAULT_MAX_BYTES = 100 * 1024 * 1024

// Hard size ceiling: abort oversized upstream bodies instead of materializing them.
async function readJsonCapped(res, maxBytes) {
    const declared = Number(res.headers?.get?.('content-length'))
    if (declared > maxBytes) {
        try { await res.body?.cancel() } catch { }
        throw new Error(`Nuvio response exceeded the ${maxBytes}-byte limit (content-length)`)
    }
    const reader = res.body?.getReader?.()
    if (!reader) return res.json()
    const chunks = []
    let received = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > maxBytes) {
            try { await reader.cancel() } catch { }
            throw new Error(`Nuvio response exceeded the ${maxBytes}-byte limit while streaming`)
        }
        chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createNuvioDriver(options = {}) {
    const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    const usedDefaultBase = !options.baseUrl
    const publishableKey = options.publishableKey || DEFAULT_PUBLISHABLE_KEY

    const makeHeaders = (accessToken) => ({
        'Content-Type': 'application/json',
        'apikey': publishableKey,
        ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {})
    })

    const rpc = async (fn, body, accessToken, opts = {}) => {
        // idempotent:true on POST is load-bearing (preserves 5xx-retry semantics for upsert ops).
        const res = await guardedResilientFetch(`${baseUrl}${RPC_PATH}/${fn}`, {
            method: 'POST',
            headers: makeHeaders(accessToken),
            body: JSON.stringify(body),
            timeout: RPC_TIMEOUT_MS,
            maxBytes: opts.maxBytes > 0 ? opts.maxBytes : RPC_DEFAULT_MAX_BYTES,
            retries: opts.retries ?? 2,
            idempotent: true
        })
        if (!res.ok) {
            const fallbackHint = res.status === 401 && usedDefaultBase
                ? ' No custom Nuvio backend URL is stored for this connection; reconnect it with your self-hosted URL.'
                : ''
            const err = new Error(`Nuvio RPC ${fn} returned ${res.status} (target: ${baseUrl}).${fallbackHint}`)
            err.status = res.status
            err.isAuthError = res.status === 401
            // body may not be JSON (proxy 502 HTML, etc.); the status code is the contract
            try { err.data = await res.json() } catch { /* response body unreadable as JSON - status carries the signal */ }
            throw err
        }
        if (res.status === 204) return null
        if (opts.maxBytes > 0) return readJsonCapped(res, opts.maxBytes)
        return res.json()
    }

    // Share profile lookups within this driver instance; token changes start a new lookup.
    let profilesRpcCache = null
    async function pullProfilesCached(accessToken) {
        if (!profilesRpcCache || profilesRpcCache.accessToken !== accessToken) {
            const promise = rpc('sync_pull_profiles', {}, accessToken)
                .then(profiles => ({ profiles: Array.isArray(profiles) ? profiles : [], failed: false }))
                .catch(() => {
                    // Retry profile resolution after a transient read failure.
                    if (profilesRpcCache?.promise === promise) profilesRpcCache = null
                    return { profiles: [], failed: true }
                })
            profilesRpcCache = { accessToken, promise }
        }
        return profilesRpcCache.promise
    }

    async function resolveProfileIndex(accessToken, profileId, opts = {}) {
        if (Number.isFinite(profileId) && profileId > 0) return profileId

        const stringId = String(profileId || '').trim()
        if (/^\d+$/.test(stringId)) return parseInt(stringId, 10)

        const cached = await pullProfilesCached(accessToken)
        const profiles = cached.profiles
        const profilesRpcFailed = cached.failed

        if (profiles.length > 0 && stringId) {
            const match = profiles.find(p => p.id === stringId)
            if (match) {
                const idx = match.profile_index ?? match.profileIndex
                if (Number.isFinite(idx) && idx > 0) return idx
            }
        }

        // A self-hosted backend has no sync_pull_profiles RPC - treat it as single-profile
        // and write to the primary. Refuse only on enumerated profiles with no id match.
        if (opts.strict && stringId && !profilesRpcFailed) {
            const err = new Error('Could not resolve the Nuvio profile to write; refusing to fall back to the primary profile')
            err.status = 404
            throw err
        }

        if (!Array.isArray(profiles) || profiles.length === 0) return 1
        const primary = profiles.find(p =>
            (p.profile_index ?? p.profileIndex) === 1
        )
        if (primary) return 1

        const first = profiles[0]
        const fallbackIdx = first.profile_index ?? first.profileIndex
        if (Number.isFinite(fallbackIdx) && fallbackIdx > 0) return fallbackIdx

        return 1
    }

    return {
        capabilities: ['addons', 'plugins', 'profiles', 'history'],

        async authenticate(email, password) {
            return traced('nuvioServerDriver', 'authenticate', {}, async () => {
                const res = await guardedWebFetch(`${baseUrl}${TOKEN_GRANT_PATH}?grant_type=password`, {
                    method: 'POST',
                    headers: makeHeaders(null),
                    body: JSON.stringify({ email, password }),
                    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS)
                })
                if (!res.ok) {
                    const err = new Error(`Nuvio auth failed: ${res.status}`)
                    err.status = res.status
                    err.isAuthError = res.status === 401 || res.status === 403
                    try { err.data = await res.json() } catch { }
                    throw err
                }
                const data = await res.json()
                return {
                    accessToken: data.access_token,
                    refreshToken: data.refresh_token,
                    expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3600) * 1000
                }
            })
        },

        async register(email, password) {
            const res = await guardedWebFetch(`${baseUrl}/auth/v1/signup`, {
                method: 'POST',
                headers: makeHeaders(null),
                body: JSON.stringify({ email, password }),
                signal: AbortSignal.timeout(AUTH_TIMEOUT_MS)
            })
            if (!res.ok) {
                let data = null
                try { data = await res.json() } catch { }
                const detail = data?.msg || data?.error_description || data?.message
                const err = new Error(`Nuvio signup failed: ${res.status}${detail ? ' - ' + detail : ''}`)
                err.status = res.status
                err.isAuthError = res.status === 400 || res.status === 403 || res.status === 422
                err.data = data
                throw err
            }
            const data = await res.json()
            if (!data.access_token) {
                const err = new Error('Account created. Confirm your email, then sign in.')
                err.needsConfirmation = true
                throw err
            }
            return {
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
                expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3600) * 1000
            }
        },

        async refreshAccessToken(refreshToken) {
            return traced('nuvioServerDriver', 'refreshAccessToken', {}, async () => {
                const res = await guardedWebFetch(`${baseUrl}${TOKEN_GRANT_PATH}?grant_type=refresh_token`, {
                    method: 'POST',
                    headers: makeHeaders(null),
                    body: JSON.stringify({ refresh_token: refreshToken }),
                    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS)
                })
                if (!res.ok) {
                    const err = new Error(`Nuvio token refresh failed: ${res.status}`)
                    err.status = res.status
                    err.isAuthError = res.status === 401
                    throw err
                }
                const data = await res.json()
                return {
                    accessToken: data.access_token,
                    refreshToken: data.refresh_token,
                    expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3600) * 1000
                }
            })
        },

        async readAddons(accessToken, profileId) {
            return traced('nuvioServerDriver', 'readAddons', {}, async () => {
                const idx = await resolveProfileIndex(accessToken, profileId)
                const query = `select=*&profile_id=eq.${idx}&order=sort_order`
                const res = await guardedWebFetch(`${baseUrl}${REST_PATH}/addons?${query}`, {
                    method: 'GET',
                    headers: makeHeaders(accessToken),
                    signal: AbortSignal.timeout(REST_TIMEOUT_MS)
                })
                if (!res.ok) {
                    const err = new Error(`Nuvio readAddons returned ${res.status}`)
                    err.status = res.status
                    err.isAuthError = res.status === 401
                    throw err
                }
                const addons = await res.json()
                return Array.isArray(addons) ? addons : []
            })
        },

        async readWatchHistory(accessToken, profileId, { page = 1, pageSize = 100000 } = {}) {
            const idx = await resolveProfileIndex(accessToken, profileId)
            const rows = await rpc('sync_pull_watched_items', {
                p_profile_id: idx,
                p_page: page,
                p_page_size: pageSize,
            }, accessToken)
            return Array.isArray(rows) ? rows : []
        },

        async readWatchProgress(accessToken, profileId) {
            const idx = await resolveProfileIndex(accessToken, profileId)
            const rows = await rpc('sync_pull_watch_progress', { p_profile_id: idx }, accessToken)
            return Array.isArray(rows) ? rows : []
        },

        async writeAddons(accessToken, addons, profileId) {
            return traced('nuvioServerDriver', 'writeAddons', { count: addons.length, urls: addons.map(a => a.transportUrl || '') }, async () => {
                const idx = await resolveProfileIndex(accessToken, profileId, { strict: true })
                const seen = new Set()
                const deduped = addons.filter(a => {
                    const url = a.transportUrl || ''
                    if (seen.has(url)) return false
                    seen.add(url)
                    return true
                })
                // sync_push_addons upserts row-by-row but rejects the whole payload when it contains the same url twice
                return rpc('sync_push_addons', {
                    p_profile_id: idx,
                    p_addons: deduped.map((a, i) => ({
                        url: a.transportUrl || '',
                        name: a.manifest?.name || '',
                        enabled: (a.flags?.enabled ?? a.enabled) !== false,
                        sort_order: i
                    }))
                }, accessToken)
            })
        },

        async readPlugins(accessToken, profileId) {
            const idx = await resolveProfileIndex(accessToken, profileId)
            const query = `select=*&profile_id=eq.${idx}&order=sort_order`
            const res = await guardedWebFetch(`${baseUrl}${REST_PATH}/plugins?${query}`, {
                method: 'GET',
                headers: makeHeaders(accessToken),
                signal: AbortSignal.timeout(REST_TIMEOUT_MS)
            })
            if (!res.ok) {
                const err = new Error(`Nuvio readPlugins returned ${res.status}`)
                err.status = res.status
                err.isAuthError = res.status === 401
                throw err
            }
            const plugins = await res.json()
            return Array.isArray(plugins) ? plugins : []
        },

        async writePlugins(accessToken, plugins, profileId) {
            const idx = await resolveProfileIndex(accessToken, profileId, { strict: true })
            return rpc('sync_push_plugins', {
                p_profile_id: idx,
                p_plugins: plugins.map((p, i) => ({
                    url: p.url,
                    name: p.name,
                    enabled: p.enabled !== false,
                    sort_order: i,
                    repo_type: p.repo_type ?? null,
                }))
            }, accessToken)
        },

        async pullProfiles(accessToken) {
            return rpc('sync_pull_profiles', {}, accessToken)
        },

        async pushProfiles(accessToken, profiles) {
            profilesRpcCache = null
            return rpc('sync_push_profiles', {
                p_profiles: profiles.map((p, i) => ({
                    profile_index: i + 1,
                    name: p.name,
                    avatar_color_hex: p.avatarColorHex || null,
                    uses_primary_addons: p.usesPrimaryAddons || false,
                    uses_primary_plugins: p.usesPrimaryPlugins || false,
                    avatar_id: p.avatarId || null
                })),
                p_client_max_profiles: 5
            }, accessToken).finally(() => { profilesRpcCache = null })
        },

        // Undocumented account-wide export RPC; takes no params, response rows pass through untouched.
        async exportAccountBackup(accessToken) {
            return traced('nuvioServerDriver', 'exportAccountBackup', {}, async () => {
                const result = await rpc('sync_export_account_backup', {}, accessToken, { maxBytes: BACKUP_EXPORT_MAX_BYTES })
                return result && typeof result === 'object' && !Array.isArray(result) ? result : { data: result }
            })
        },

        // grant_type=anonymous is rejected upstream; device sessions bootstrap via anonymous
        // signup (Nuvio's own clients do the same). Reuse the token across polls (rate-limited).
        async getAnonymousToken() {
            return traced('nuvioServerDriver', 'getAnonymousToken', {}, async () => {
                const res = await guardedWebFetch(`${baseUrl}/auth/v1/signup`, {
                    method: 'POST',
                    headers: makeHeaders(null),
                    body: JSON.stringify({ data: { tv_client: 'aiomanager' } }),
                    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS)
                })
                if (!res.ok) {
                    const err = new Error(`Nuvio device session failed: ${res.status}`)
                    err.status = res.status
                    err.isAuthError = res.status === 401 || res.status === 403
                    try { err.data = await res.json() } catch { }
                    throw err
                }
                const data = await res.json()
                return data.access_token
            })
        },

        async startTvLoginSession({ deviceNonce, redirectBaseUrl, deviceName }, anonToken) {
            return traced('nuvioServerDriver', 'startTvLoginSession', {}, async () => {
                const rows = await rpc('start_tv_login_session', {
                    p_device_nonce: deviceNonce,
                    p_redirect_base_url: redirectBaseUrl ?? null,
                    p_device_name: deviceName ?? null
                }, anonToken)
                return Array.isArray(rows) ? rows[0] : rows
            })
        },

        // A P0001 raise arrives as HTTP 400 from PostgREST; routes surface it as a client 400.
        async pollTvLoginSession({ code, deviceNonce }, anonToken) {
            return traced('nuvioServerDriver', 'pollTvLoginSession', {}, async () => {
                const rows = await rpc('poll_tv_login_session', {
                    p_code: code,
                    p_device_nonce: deviceNonce
                }, anonToken)
                const row = Array.isArray(rows) ? rows[0] : null
                return row?.status ?? 'pending'
            })
        },

        // Edge function, not an RPC: apikey-only auth, no rpc() retry wrapper.
        async exchangeTvLogin({ code, deviceNonce }) {
            return traced('nuvioServerDriver', 'exchangeTvLogin', {}, async () => {
                const res = await guardedWebFetch(`${baseUrl}/functions/v1/tv-logins-exchange`, {
                    method: 'POST',
                    headers: makeHeaders(null),
                    body: JSON.stringify({ code, device_nonce: deviceNonce }),
                    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS)
                })
                if (!res.ok) {
                    const err = new Error(`Nuvio TV login exchange failed: ${res.status}`)
                    err.status = res.status
                    err.isAuthError = res.status === 401 || res.status === 403
                    try { err.data = await res.json() } catch { }
                    throw err
                }
                const data = await res.json()
                return {
                    accessToken: data.access_token,
                    refreshToken: data.refresh_token,
                    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
                    user: data.user
                }
            })
        }
    }
}
