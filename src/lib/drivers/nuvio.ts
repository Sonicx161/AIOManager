const DEFAULT_BASE_URL = 'https://api.nuvio.tv'
const DEFAULT_PUBLISHABLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI'
const REST_PATH = '/rest/v1'
const RPC_PATH = `${REST_PATH}/rpc`
export { DEFAULT_BASE_URL, DEFAULT_PUBLISHABLE_KEY }
const RPC_TIMEOUT_MS = 30000
const REST_TIMEOUT_MS = 15000
const NUVIO_SNAPSHOT_LIMIT = 100000

import { trace } from '../trace.ts'
import { mapAvatarRows } from '../nuvio-avatars.ts'
import { resolveProfileIndexWith } from './nuvio-profile.ts'
import { getNuvioProfiles, invalidateNuvioProfileCache } from '../nuvio-profile-cache.ts'
import { validateNuvioRows } from '../nuvio-read-validation.ts'
import { pullNuvioWatchedPages } from '../nuvio-pagination.ts'
import type { NuvioAvatar } from '../nuvio-avatars.ts'

export interface NuvioWatchedRow {
    content_id: string
    content_type?: string
    title?: string
    season?: number | null
    episode?: number | null
    watched_at?: number
}

export interface NuvioProgressRow {
    content_id: string
    content_type?: string
    video_id?: string
    season?: number | null
    episode?: number | null
    position?: number
    duration?: number
    progressPercent?: number
    last_watched?: number
}

// Keep the profile cache outside createNuvioDriver because the factory intentionally
// creates a new driver for each surface (library, activity, workspace). A pending
// promise also coalesces the two history RPCs issued in parallel.
const PROFILE_TTL_MS = 60 * 1000
const MAX_PROFILE_EPOCHS = 64
const profileEpochs = new Map<string, { epoch: number; at: number }>()

// Rosters change in the Nuvio app, so a cached list expires after the TTL or on a fresh read.
function profileCacheKey(accessToken: string, fresh: boolean): string {
    const now = Date.now()
    const prev = profileEpochs.get(accessToken)
    let entry = prev
    if (!entry || fresh || now - entry.at >= PROFILE_TTL_MS) {
        entry = { epoch: prev ? prev.epoch + 1 : 0, at: now }
        profileEpochs.delete(accessToken)
        profileEpochs.set(accessToken, entry)
        while (profileEpochs.size > MAX_PROFILE_EPOCHS) {
            const oldest = profileEpochs.keys().next().value
            if (oldest === undefined) break
            profileEpochs.delete(oldest)
        }
    }
    return `${accessToken}#${entry.epoch}`
}

interface NuvioError extends Error {
    status?: number
    isAuthError?: boolean
    data?: unknown
}

interface DriverAddon {
    transportUrl?: string
    manifest?: { name?: string }
    flags?: { enabled?: boolean }
    enabled?: boolean
}

interface DriverPlugin {
    url?: string
    name?: string
    enabled?: boolean
    repo_type?: string | null
}

export function createNuvioDriver(options: { baseUrl?: string; publishableKey?: string } = {}) {
    const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    const publishableKey = options.publishableKey || DEFAULT_PUBLISHABLE_KEY

    const makeHeaders = (accessToken?: string): Record<string, string> => ({
        'Content-Type': 'application/json',
        'apikey': publishableKey,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    })

    const rpc = async (fn: string, body: unknown, accessToken: string, opts: { retries?: number } = {}) => {
        const retries = opts.retries ?? 2
        let lastErr: unknown
        for (let attempt = 0; attempt <= retries; attempt++) {
            let res: Response
            try {
                res = await fetch(`${baseUrl}${RPC_PATH}/${fn}`, {
                    method: 'POST',
                    headers: makeHeaders(accessToken),
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
                })
            } catch (err) {
                lastErr = err
                if (attempt < retries) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue }
                throw err
            }
            if (!res.ok) {
                const err: NuvioError = new Error(`Nuvio RPC ${fn} returned ${res.status}`)
                err.status = res.status
                err.isAuthError = res.status === 401
                try { err.data = await res.json() } catch {}
                if (res.status >= 500 && attempt < retries) { lastErr = err; await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue }
                throw err
            }
            if (res.status === 204) return null
            return res.json()
        }
        throw lastErr
    }

    const getProfiles = async (accessToken: string, fresh = false) =>
        getNuvioProfiles(profileCacheKey(accessToken, fresh), () => rpc('sync_pull_profiles', {}, accessToken))

    const resolveProfileIndex = async (accessToken: string, profileId?: string | number, opts: { strict?: boolean } = {}): Promise<number> => {
        const { index } = await resolveProfileIndexWith(
            () => getProfiles(accessToken),
            profileId,
            opts,
        )
        return index
    }

    return {
        async pullProfiles(accessToken: string, opts: { fresh?: boolean } = {}): Promise<Array<Record<string, unknown>>> {
            const start = Date.now()
            trace('nuvioDriver', 'pullProfiles.start', {})
            try {
                const result = await getProfiles(accessToken, opts.fresh === true)
                trace('nuvioDriver', 'pullProfiles.success', { count: result.length, timing: Date.now() - start })
                return result
            } catch (err) {
                trace('nuvioDriver', 'pullProfiles.error', { error: (err as NuvioError)?.message, timing: Date.now() - start })
                throw err
            }
        },

        async writeAddons(accessToken: string, addons: DriverAddon[], profileId?: string | number) {
            const start = Date.now()
            trace('nuvioDriver', 'writeAddons.start', { count: addons.length, urls: addons.map(a => a.transportUrl || '') })
            try {
                const idx = await resolveProfileIndex(accessToken, profileId, { strict: true })
                const result = await rpc('sync_push_addons', {
                    p_profile_id: idx,
                    p_addons: addons.map((a, i) => ({
                        url: a.transportUrl || '',
                        name: a.manifest?.name || '',
                        enabled: (a.flags?.enabled ?? a.enabled) !== false,
                        sort_order: i,
                    })),
                }, accessToken)
                trace('nuvioDriver', 'writeAddons.success', { count: addons.length, profileIndex: idx, timing: Date.now() - start })
                return result
            } catch (err) {
                trace('nuvioDriver', 'writeAddons.error', { count: addons.length, error: (err as NuvioError)?.message, timing: Date.now() - start })
                throw err
            }
        },

        async readAddons(accessToken: string, profileId?: string | number) {
            const start = Date.now()
            trace('nuvioDriver', 'readAddons.start', {})
            try {
                const idx = await resolveProfileIndex(accessToken, profileId)
                const query = `select=*&profile_id=eq.${idx}&order=sort_order`
                const res = await fetch(`${baseUrl}${REST_PATH}/addons?${query}`, {
                    method: 'GET',
                    headers: makeHeaders(accessToken),
                    signal: AbortSignal.timeout(REST_TIMEOUT_MS),
                })
                if (!res.ok) {
                    const err: NuvioError = new Error(`Nuvio readAddons returned ${res.status}`)
                    err.status = res.status
                    err.isAuthError = res.status === 401
                    throw err
                }
                const addons = await res.json()
                const result = Array.isArray(addons) ? addons : []
                trace('nuvioDriver', 'readAddons.success', { count: result.length, profileIndex: idx, timing: Date.now() - start })
                return result
            } catch (err) {
                trace('nuvioDriver', 'readAddons.error', { error: (err as NuvioError)?.message, timing: Date.now() - start })
                throw err
            }
        },

        async readWatchHistory(accessToken: string, profileId?: string | number, opts: { page?: number; pageSize?: number } = {}) {
            const start = Date.now()
            trace('nuvioDriver', 'readWatchHistory.start', {})
            try {
                const idx = await resolveProfileIndex(accessToken, profileId)
                const result = opts.page !== undefined || opts.pageSize !== undefined
                    ? validateNuvioRows<NuvioWatchedRow>(await rpc('sync_pull_watched_items', {
                        p_profile_id: idx,
                        p_page: opts.page ?? 1,
                        p_page_size: opts.pageSize ?? NUVIO_SNAPSHOT_LIMIT,
                    }, accessToken), 'sync_pull_watched_items', opts.pageSize === undefined ? NUVIO_SNAPSHOT_LIMIT : Number.POSITIVE_INFINITY)
                    : await pullNuvioWatchedPages<NuvioWatchedRow>(
                        (page, pageSize) => rpc('sync_pull_watched_items', { p_profile_id: idx, p_page: page, p_page_size: pageSize }, accessToken),
                    )
                trace('nuvioDriver', 'readWatchHistory.success', { count: result.length, profileIndex: idx, timing: Date.now() - start })
                return result
            } catch (err) {
                trace('nuvioDriver', 'readWatchHistory.error', { error: (err as NuvioError)?.message, timing: Date.now() - start })
                throw err
            }
        },

        async readWatchProgress(accessToken: string, profileId?: string | number) {
            const idx = await resolveProfileIndex(accessToken, profileId)
            const rows = await rpc('sync_pull_watch_progress', {
                p_profile_id: idx,
                p_since_last_watched: 0,
                p_limit: NUVIO_SNAPSHOT_LIMIT,
            }, accessToken)
            return validateNuvioRows<NuvioProgressRow>(rows, 'sync_pull_watch_progress', NUVIO_SNAPSHOT_LIMIT)
        },

        async readPlugins(accessToken: string, profileId?: string | number) {
            const idx = await resolveProfileIndex(accessToken, profileId)
            const query = `select=*&profile_id=eq.${idx}&order=sort_order`
            const res = await fetch(`${baseUrl}${REST_PATH}/plugins?${query}`, {
                method: 'GET',
                headers: makeHeaders(accessToken),
                signal: AbortSignal.timeout(REST_TIMEOUT_MS),
            })
            if (!res.ok) {
                const err: NuvioError = new Error(`Nuvio readPlugins returned ${res.status}`)
                err.status = res.status
                err.isAuthError = res.status === 401
                throw err
            }
            const plugins = await res.json()
            return Array.isArray(plugins) ? plugins : []
        },

        async writePlugins(accessToken: string, plugins: DriverPlugin[], profileId?: string | number) {
            const idx = await resolveProfileIndex(accessToken, profileId, { strict: true })
            return rpc('sync_push_plugins', {
                p_profile_id: idx,
                p_plugins: plugins.map((p, i) => ({
                    url: p.url,
                    name: p.name,
                    enabled: p.enabled !== false,
                    sort_order: i,
                    repo_type: p.repo_type ?? null,
                })),
            }, accessToken)
        },

        // Read-only surfaces. AIOManager manages addons/plugins; library, collections, and settings
        // are user-owned on Nuvio and only displayed here (their pushes are full-replace, so writing
        // a partial view would delete the user's data).
        async readLibrary(accessToken: string, profileId?: string | number, opts: { limit?: number; offset?: number } = {}) {
            const idx = await resolveProfileIndex(accessToken, profileId)
            const rows = await rpc('sync_pull_library', { p_profile_id: idx, p_limit: opts.limit ?? 500, p_offset: opts.offset ?? 0 }, accessToken)
            return Array.isArray(rows) ? rows : []
        },

        async readCollections(accessToken: string, profileId?: string | number): Promise<Array<Record<string, unknown>>> {
            const idx = await resolveProfileIndex(accessToken, profileId)
            const res = await rpc('sync_pull_collections', { p_profile_id: idx }, accessToken)
            const obj = Array.isArray(res) ? res[0] : res
            const list = obj?.collections_json
            if (typeof list === 'string') {
                try {
                    const parsed = JSON.parse(list)
                    return Array.isArray(parsed) ? parsed : []
                } catch { return [] }
            }
            return Array.isArray(list) ? list : []
        },

        // Rename via a surgical PostgREST PATCH on the profiles row (by uuid), so it can't touch
        // other profiles the way the sync_push_profiles RPC might.
        async renameProfile(accessToken: string, profileId: string, name: string, avatarId?: string) {
            const res = await fetch(`${baseUrl}${REST_PATH}/profiles?id=eq.${encodeURIComponent(profileId)}`, {
                method: 'PATCH',
                headers: { ...makeHeaders(accessToken), Prefer: 'return=minimal' },
                body: JSON.stringify(avatarId !== undefined ? { name, avatar_id: avatarId } : { name }),
                signal: AbortSignal.timeout(REST_TIMEOUT_MS),
            })
            if (!res.ok) {
                const err: NuvioError = new Error(`Nuvio renameProfile returned ${res.status}`)
                err.status = res.status
                err.isAuthError = res.status === 401
                throw err
            }
            invalidateNuvioProfileCache()
            return null
        },

        async createProfile(accessToken: string, params: { profileIndex: number; name: string; avatarColorHex?: string; avatarId?: string }) {
            const existing = await rpc('sync_pull_profiles', {}, accessToken)
            const rows: Array<Record<string, unknown>> = Array.isArray(existing) ? existing : []
            const p_profiles = rows
                .filter(r => Number(r.profile_index ?? r.profileIndex) !== params.profileIndex)
                .map(r => ({
                    profile_index: Number(r.profile_index ?? r.profileIndex),
                    name: r.name,
                    avatar_color_hex: r.avatar_color_hex ?? null,
                    uses_primary_addons: r.uses_primary_addons ?? false,
                    uses_primary_plugins: r.uses_primary_plugins ?? false,
                    avatar_id: r.avatar_id ?? null,
                }))
            p_profiles.push({
                profile_index: params.profileIndex,
                name: params.name,
                avatar_color_hex: params.avatarColorHex ?? null,
                uses_primary_addons: false,
                uses_primary_plugins: false,
                avatar_id: params.avatarId ?? null,
            })
            const result = await rpc('sync_push_profiles', { p_profiles, p_client_max_profiles: 5 }, accessToken, { retries: 0 })
            invalidateNuvioProfileCache()
            return result
        },

        async deleteProfile(accessToken: string, profileId: string | number) {
            const idx = await resolveProfileIndex(accessToken, profileId, { strict: true })
            const result = await rpc('sync_delete_profile_data', { p_profile_id: idx }, accessToken, { retries: 0 })
            invalidateNuvioProfileCache()
            return result
        },

        async deleteWatchHistory(accessToken: string, keys: Array<{ content_id: string; season?: number; episode?: number }>, profileId?: string | number) {
            const start = Date.now()
            const cleaned = (keys || []).filter(k => k && k.content_id)
            trace('nuvioDriver', 'deleteWatchHistory.start', { keys: cleaned.length })
            if (cleaned.length === 0) return null
            const idx = await resolveProfileIndex(accessToken, profileId, { strict: true })
            try {
                const result = await rpc('sync_delete_watched_items', { p_profile_id: idx, p_keys: cleaned }, accessToken, { retries: 0 })
                trace('nuvioDriver', 'deleteWatchHistory.success', { keys: cleaned.length, profileIndex: idx, timing: Date.now() - start })
                return result
            } catch (err) {
                trace('nuvioDriver', 'deleteWatchHistory.error', { keys: cleaned.length, profileIndex: idx, status: (err as NuvioError)?.status, error: (err as Error)?.message, timing: Date.now() - start })
                throw err
            }
        },

        async deleteWatchProgress(accessToken: string, progressKeys: string[], profileId?: string | number) {
            const start = Date.now()
            const cleaned = (progressKeys || []).filter(Boolean)
            trace('nuvioDriver', 'deleteWatchProgress.start', { keys: cleaned.length })
            if (cleaned.length === 0) return null
            const idx = await resolveProfileIndex(accessToken, profileId, { strict: true })
            try {
                const result = await rpc('sync_delete_watch_progress', { p_profile_id: idx, p_keys: cleaned }, accessToken, { retries: 0 })
                trace('nuvioDriver', 'deleteWatchProgress.success', { keys: cleaned.length, profileIndex: idx, timing: Date.now() - start })
                return result
            } catch (err) {
                trace('nuvioDriver', 'deleteWatchProgress.error', { keys: cleaned.length, profileIndex: idx, status: (err as NuvioError)?.status, error: (err as Error)?.message, timing: Date.now() - start })
                throw err
            }
        },

        async getMemberAccess(accessToken: string): Promise<unknown> {
            const rows = await rpc('get_my_member_access', {}, accessToken)
            return Array.isArray(rows) ? rows : []
        },

        async getAvatarCatalog(): Promise<NuvioAvatar[]> {
            const start = Date.now()
            trace('nuvioDriver', 'getAvatarCatalog.start', {})
            try {
                const res = await fetch(`${baseUrl}${RPC_PATH}/get_avatar_catalog`, {
                    method: 'POST',
                    headers: makeHeaders(),
                    body: JSON.stringify({}),
                    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
                })
                if (!res.ok) {
                    const err: NuvioError = new Error(`Nuvio getAvatarCatalog returned ${res.status}`)
                    err.status = res.status
                    err.isAuthError = res.status === 401
                    throw err
                }
                const result = mapAvatarRows(await res.json())
                trace('nuvioDriver', 'getAvatarCatalog.success', { count: result.length, timing: Date.now() - start })
                return result
            } catch (err) {
                trace('nuvioDriver', 'getAvatarCatalog.error', { error: (err as NuvioError)?.message, timing: Date.now() - start })
                throw err
            }
        },
    }
}
