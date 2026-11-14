import { createHash } from 'node:crypto'
import db from '../db.js'
import { kvHeadSource } from '../lib/kv-head.js'
import { decrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'
import { verifyAuth } from '../auth.js'
import { metadataCache, PERMANENT_TTL } from '../lib/metadata-cache.js'
import { loadUserKey } from '../lib/user-key-cache.js'
import { maskContext } from '../utils/log-helpers.js'
import { resilientFetch } from '../utils/api-resilience.js'

const TMDB_V3_API_BASE = 'https://api.themoviedb.org/3'
const SUPPORTED_PROVIDERS = new Set(['tmdb'])
const DEFAULT_TTL_DETAILS_MS = 24 * 60 * 60 * 1000
const DEFAULT_TTL_LONG_MS = 7 * 24 * 60 * 60 * 1000
// find: empty buckets get the short TTL, non-empty results become permanent (see findTtlFromValue)
const DEFAULT_TTL_FIND_MS = 60 * 60 * 1000

const RATE_LIMIT_PROXY = { max: 300, timeWindow: '1 minute' }

const ErrorResponse = {
    type: 'object',
    required: ['error'],
    properties: { error: { type: 'string' } }
}

export function _redactKey(input) {
    if (input == null) return input
    if (typeof input === 'string') {
        return input
            .replace(/api_key=[a-fA-F0-9_-]{16,}/gi, 'api_key=REDACTED')
            .replace(/api_key=[a-zA-Z0-9._-]{16,}/g, 'api_key=REDACTED')
            .replace(/Bearer\s+eyJ[a-zA-Z0-9._-]+/gi, 'Bearer REDACTED')
            .replace(/eyJ[a-zA-Z0-9._-]{20,}/g, 'REDACTED_JWT')
            .replace(/\b[a-fA-F0-9]{32}\b/g, 'REDACTED_HEX32')
    }
    if (typeof input === 'object') {
        try {
            const json = JSON.stringify(input)
            return JSON.parse(_redactKey(json))
        } catch {
            return '[unredactable]'
        }
    }
    try {
        return _redactKey(String(input))
    } catch {
        return '[unredactable]'
    }
}

function normalizeProvider(raw) {
    if (typeof raw !== 'string') return null
    const lower = raw.trim().toLowerCase()
    if (!lower) return null
    if (!SUPPORTED_PROVIDERS.has(lower)) return null
    return lower
}

function buildTmdbRequest(pathParts, query, key, keyFormat) {
    const cleanPath = pathParts
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/')
    if (keyFormat === 'v4') {
        const url = query
            ? `${TMDB_V3_API_BASE}/${cleanPath}?${query}`
            : `${TMDB_V3_API_BASE}/${cleanPath}`
        return {
            url,
            init: {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${key}`,
                    Accept: 'application/json',
                },
            },
        }
    }
    const url = query
        ? `${TMDB_V3_API_BASE}/${cleanPath}?api_key=${key}&${query}`
        : `${TMDB_V3_API_BASE}/${cleanPath}?api_key=${key}`
    return {
        url,
        init: {
            method: 'GET',
            headers: { Accept: 'application/json' },
        },
    }
}

// Empty find buckets can be transient upstream lag; non-empty finds are immutable — pick TTL per value.
const FIND_RESULT_BUCKETS = ['movie_results', 'tv_results', 'tv_episode_results', 'tv_season_results']
function findTtlFromValue(text) {
    try {
        const data = JSON.parse(text)
        const hit = FIND_RESULT_BUCKETS.some(b => Array.isArray(data?.[b]) && data[b].length > 0)
        return hit ? PERMANENT_TTL : DEFAULT_TTL_FIND_MS
    } catch {
        return DEFAULT_TTL_FIND_MS
    }
}

function classifyTmdbKey(pathParts, query) {
    const resource = (pathParts[0] || '').toLowerCase()
    if (resource === 'find') return { kind: 'find', ttl: DEFAULT_TTL_FIND_MS }
    if (resource === 'trending') return { kind: 'trending', ttl: DEFAULT_TTL_DETAILS_MS }
    if (resource === 'movie' || resource === 'tv') {
        const sub = (pathParts[2] || '').toLowerCase()
        if (sub === 'videos') return { kind: 'videos', ttl: DEFAULT_TTL_LONG_MS }
        if (sub === 'recommendations' || sub === 'similar') return { kind: 'recs', ttl: DEFAULT_TTL_LONG_MS }
        if (!sub) return { kind: 'details', ttl: DEFAULT_TTL_DETAILS_MS }
        return { kind: sub || 'misc', ttl: DEFAULT_TTL_DETAILS_MS }
    }
    return { kind: 'misc', ttl: DEFAULT_TTL_DETAILS_MS }
}

// TMDB responses vary by these query params. Every tmdb cache key must carry them:
// the cache is shared across users and persisted to the DB, so omitting them lets
// one user's locale/page choice poison the entry served to everyone else.
const TMDB_VARIANT_PARAMS = ['language', 'region', 'watch_region', 'include_image_language', 'timezone', 'page']
function tmdbVariantSuffix(query) {
    const q = query || ''
    const parts = []
    for (const p of TMDB_VARIANT_PARAMS) {
        const m = q.match(new RegExp(`(?:^|&)${p}=([^&]*)`, 'i'))
        if (m) parts.push(`${p}=${m[1]}`)
    }
    return parts.length ? `:${parts.join('&')}` : ''
}

function buildCacheKey(provider, pathParts, query) {
    const resource = (pathParts[0] || '').toLowerCase()
    if (provider === 'tmdb') {
        if (resource === 'find') {
            // Key segments stay percent-encoded: decoded values could contain ':' and
            // forge collisions against other tuples in this shared, persisted cache.
            const imdbMatch = (query || '').match(/external_id=([^&]+)/i)
            const imdbId = imdbMatch ? imdbMatch[1] : encodeURIComponent(pathParts[1] || 'unknown')
            const sourceMatch = (query || '').match(/external_source=([^&]+)/i)
            const source = sourceMatch ? sourceMatch[1] : 'unknown'
            const langMatch = (query || '').match(/language=([^&]+)/i)
            const lang = langMatch ? langMatch[1] : 'en'
            return `tmdb:find:${source}:${imdbId}:${lang}`
        }
        const variant = tmdbVariantSuffix(query)
        if (resource === 'trending') {
            const mediaType = (pathParts[1] || 'all').toLowerCase()
            const window = (pathParts[2] || 'week').toLowerCase()
            return `tmdb:trending:${mediaType}:${window}${variant}`
        }
        if (resource === 'movie' || resource === 'tv') {
            const tmdbId = String(pathParts[1] || 'unknown')
            const sub = (pathParts[2] || '').toLowerCase()
            if (sub === 'videos') return `tmdb:videos:${resource}:${tmdbId}${variant}`
            if (sub === 'recommendations' || sub === 'similar') return `tmdb:recommendations:${resource}:${tmdbId}${variant}`
            if (sub === 'season') {
                const seasonNum = pathParts[3] || 'unknown'
                const episodeSub = (pathParts[4] || '').toLowerCase()
                const episodeNum = pathParts[5] || 'unknown'
                if (episodeSub === 'episode') {
                    const appendMatch = (query || '').match(/append_to_response=([^&]+)/i)
                    const append = appendMatch ? appendMatch[1] : ''
                    return `tmdb:episode:${resource}:${tmdbId}:${seasonNum}:${episodeNum}:${append}${variant}`
                }
                return `tmdb:season:${resource}:${tmdbId}:${seasonNum}${variant}`
            }
            if (!sub) {
                const appendMatch = (query || '').match(/append_to_response=([^&]+)/i)
                const append = appendMatch ? appendMatch[1] : ''
                return `tmdb:details:${resource}:${tmdbId}:${append}${variant}`
            }
            return `tmdb:${sub}:${resource}:${tmdbId}${variant}`
        }
    }
    return `${provider}:${resource}:${(pathParts || []).slice(1).join(':') || 'root'}:${query || ''}`
}

const UPSTREAM_TIMEOUT_MS = 15_000
const UPSTREAM_RETRIES = 1

async function fetchUpstream(requestDescriptor) {
    const response = await resilientFetch(requestDescriptor.url, {
        ...requestDescriptor.init,
        timeout: UPSTREAM_TIMEOUT_MS,
        retries: UPSTREAM_RETRIES,
    })
    const text = await response.text()
    if (!response.ok) {
        const err = new Error(`upstream status ${response.status}`)
        err.status = response.status
        throw err
    }
    return text
}

async function workspaceBinding(userId) {
    const row = await db.get(`SELECT password FROM ${kvHeadSource()} WHERE key = $1`, [userId])
    return row ? String(row.password ?? '') : null
}

export function registerMetadataProxyRoutes(fastify) {
    metadataCache.startCleanupJob()
    metadataCache.cleanupPoisonedFindRows().catch(() => {})

    fastify.get('/api/metadata/:provider/*', {
        config: { rateLimit: RATE_LIMIT_PROXY },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        const binding = authUser ? await workspaceBinding(authUser) : null
        if (binding === null) {
            reply.status(401); return { error: 'Unauthorized' }
        }

        const provider = normalizeProvider(request.params.provider)
        if (!provider) {
            reply.status(400); return { error: 'Unsupported provider' }
        }

        const wildcard = request.params['*'] || ''
        const pathParts = String(wildcard).split('/').filter(Boolean)
        if (pathParts.length === 0) {
            reply.status(400); return { error: 'Missing resource path' }
        }

        let keyRecord
        try {
            keyRecord = await loadUserKey(authUser, provider, binding)
        } catch (err) {
            fastify.log.error({ category: 'MetadataProxy' }, `Key lookup failed for user ${maskContext(authUser)} provider ${provider}: ${_redactKey(err && err.message)}`)
            reply.status(500); return { error: 'Key lookup failed' }
        }

        if (!keyRecord) {
            reply.status(401); return { error: 'Provider key not configured' }
        }

        const incomingQuery = request.query && typeof request.query === 'object' ? request.query : {}
        const sortedQuery = Object.keys(incomingQuery)
            .sort()
            .filter(k => k && typeof incomingQuery[k] !== 'undefined' && incomingQuery[k] !== null)
            .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(incomingQuery[k]))}`)
            .join('&')

        const requestDescriptor = buildTmdbRequest(pathParts, sortedQuery, keyRecord.key, keyRecord.format)
        const classification = classifyTmdbKey(pathParts, sortedQuery)
        const cacheKey = buildCacheKey(provider, pathParts, sortedQuery)

        const options = classification.kind === 'find'
            ? { ttl: classification.ttl, ttlFromValue: findTtlFromValue }
            : { ttl: classification.ttl }

        let result
        try {
            result = await metadataCache.get(cacheKey, () => fetchUpstream(requestDescriptor), options)
        } catch (err) {
            const status = err && err.status ? err.status : 502
            const safeMessage = err && err.name === 'AbortError'
                ? 'upstream timeout'
                : _redactKey((err && err.message) || 'upstream fetch failed')
            fastify.log.warn({ category: 'MetadataProxy' }, `Fetch failed for ${provider}:${classification.kind} user ${maskContext(authUser)}: ${safeMessage}`)
            reply.status(status >= 400 && status < 600 ? status : 502)
            return { error: safeMessage }
        }

        return (result && result.value !== undefined) ? result.value : null
    })

    fastify.get('/api/metadata/test', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: {
            tags: ['metadata'],
            summary: 'Test a stored (or unsaved) provider API key',
            querystring: {
                type: 'object',
                properties: {
                    provider: { type: 'string', description: 'Defaults to tmdb' },
                    key: { type: 'string', description: 'Unsaved key value to test instead of the stored one' }
                }
            },
            response: {
                200: {
                    type: 'object',
                    required: ['success', 'message', 'source'],
                    properties: {
                        success: { type: 'boolean' },
                        message: { type: 'string' },
                        source: { type: ['string', 'null'], description: 'Where the tested key came from (user, unsaved) or null' }
                    }
                },
                401: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        const binding = authUser ? await workspaceBinding(authUser) : null
        if (binding === null) {
            reply.status(401); return { error: 'Unauthorized' }
        }

        const provider = (request.query.provider || 'tmdb').toLowerCase()

        let keyRecord
        const unsavedKey = typeof request.query.key === 'string' && request.query.key.trim() ? request.query.key.trim() : null
        if (unsavedKey) {
            const format = unsavedKey.startsWith('eyJ') ? 'v4' : (/^[0-9a-fA-F]{32}$/.test(unsavedKey) ? 'v3' : 'v3')
            keyRecord = { key: unsavedKey, format, source: 'unsaved' }
        } else {
            try {
                keyRecord = await loadUserKey(authUser, provider, binding)
            } catch {
                reply.status(500); return { error: 'Key lookup failed' }
            }
        }

        if (!keyRecord) {
            const envVar = provider === 'tmdb' ? 'TMDB_API_KEY' : `${provider.toUpperCase()}_API_KEY`
            return {
                success: false,
                message: `No ${provider.toUpperCase()} key configured.`,
                source: null,
            }
        }

        if (provider === 'tmdb') {
            const testReq = buildTmdbRequest(['configuration'], '', keyRecord.key, keyRecord.format)
            try {
                const text = await fetchUpstream(testReq)
                const data = JSON.parse(text)
                if (data && data.images) {
                    return {
                        success: true,
                        message: `TMDB API key is working.`,
                        source: keyRecord.source,
                    }
                }
                return { success: false, message: 'TMDB returned an unexpected response.', source: keyRecord.source }
            } catch (err) {
                const status = err?.status
                const reason = status === 401 ? 'Invalid or expired API key' : `TMDB request failed (status ${status || 'unknown'})`
                return { success: false, message: reason, source: keyRecord.source }
            }
        }

        return {
            success: true,
            message: `${provider.toUpperCase()} key stored and ready.`,
            source: keyRecord.source,
        }
    })

    fastify.decorate('metadataCache', metadataCache)

    const PMDB_BASE = 'https://publicmetadb.com/api/external'
    const RATE_LIMIT_PMDB = { max: 300, timeWindow: '1 minute' }

    const AUX_CACHE_TTL_DEFAULT = 6 * 60 * 60 * 1000

    async function auxMetadataGet(cacheKey, fetcher, ttl = AUX_CACHE_TTL_DEFAULT, owner = null) {
        const result = await metadataCache.get(cacheKey, fetcher, { ttl, owner })
        return { value: result && result.value, hit: result ? result.source !== 'miss' && result.source !== 'stale' : false }
    }

    function makeUpstreamError(prefix, status) {
        const err = new Error(`${prefix} upstream error (${status})`)
        err.status = status
        return err
    }

    fastify.get('/api/metadata/pmdb/*', {
        config: { rateLimit: RATE_LIMIT_PMDB },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        const binding = authUser ? await workspaceBinding(authUser) : null
        if (binding === null) { reply.status(401); return { error: 'Unauthorized' } }

        let keyRecord
        try {
            keyRecord = await loadUserKey(authUser, 'pmdb', binding)
        } catch {
            reply.status(500); return { error: 'Key lookup failed' }
        }
        if (!keyRecord) {
            reply.status(401); return { error: 'PMDB key not configured' }
        }

        const wildcard = request.params['*'] || ''
        const pathParts = String(wildcard).split('/').filter(Boolean)
        if (pathParts.length === 0) {
            reply.status(400); return { error: 'Missing resource path' }
        }

        const cleanPath = pathParts.map(encodeURIComponent).join('/')
        const incomingQuery = request.query && typeof request.query === 'object' ? request.query : {}
        const queryString = Object.keys(incomingQuery)
            .filter(k => k && incomingQuery[k] !== undefined && incomingQuery[k] !== null)
            .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(incomingQuery[k]))}`)
            .join('&')

        const url = queryString
            ? `${PMDB_BASE}/${cleanPath}?${queryString}`
            : `${PMDB_BASE}/${cleanPath}`

        const owner = { id: authUser, password: binding }
        const version = createHash('sha256').update(String(binding)).digest('hex')
        const cacheKey = JSON.stringify(['private-v2', authUser, version, 'pmdb', url])
        try {
            const { value, hit } = await auxMetadataGet(cacheKey, async () => {
                const controller = new AbortController()
                if (request.socket && !request.socket.destroyed) {
                    request.socket.once('close', () => controller.abort())
                }
                const response = await resilientFetch(url, {
                    headers: {
                        Authorization: `Bearer ${keyRecord.key}`,
                        Accept: 'application/json',
                    },
                    signal: controller.signal,
                    timeout: UPSTREAM_TIMEOUT_MS,
                    retries: UPSTREAM_RETRIES,
                })
                const text = await response.text()
                if (!response.ok) throw makeUpstreamError('PMDB', response.status)
                return text
            }, AUX_CACHE_TTL_DEFAULT, owner)
            reply.header('Content-Type', 'application/json')
            if (hit) reply.header('X-Cache', 'HIT')
            return value
        } catch (err) {
            const status = err?.status || (err?.name === 'AbortError' ? 504 : 502)
            reply.status(status)
            return { error: `PMDB upstream error (${status})` }
        }
    })

    async function pmdbMutate(request, reply, method) {
        const authUser = await verifyAuth(request)
        const binding = authUser ? await workspaceBinding(authUser) : null
        if (binding === null) { reply.status(401); return { error: 'Unauthorized' } }

        let keyRecord
        try { keyRecord = await loadUserKey(authUser, 'pmdb', binding) } catch { reply.status(500); return { error: 'Key lookup failed' } }
        if (!keyRecord) { reply.status(401); return { error: 'PMDB key not configured' } }

        const wildcard = request.params['*'] || ''
        const pathParts = String(wildcard).split('/').filter(Boolean)
        if (pathParts.length === 0) { reply.status(400); return { error: 'Missing resource path' } }

        const cleanPath = pathParts.map(encodeURIComponent).join('/')
        const incomingQuery = request.query && typeof request.query === 'object' ? request.query : {}
        const queryString = Object.keys(incomingQuery)
            .filter(k => k && incomingQuery[k] !== undefined && incomingQuery[k] !== null)
            .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(incomingQuery[k]))}`)
            .join('&')

        const url = queryString
            ? `${PMDB_BASE}/${cleanPath}?${queryString}`
            : `${PMDB_BASE}/${cleanPath}`

        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 15000)
            if (request.socket && !request.socket.destroyed) {
                request.socket.once('close', () => controller.abort())
            }
            const fetchOptions = {
                method,
                headers: {
                    Authorization: `Bearer ${keyRecord.key}`,
                    Accept: 'application/json',
                },
                signal: controller.signal,
            }
            if (method !== 'DELETE' && request.body !== undefined && request.body !== null) {
                fetchOptions.headers['Content-Type'] = 'application/json'
                fetchOptions.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
            }
            const response = await fetch(url, fetchOptions)
            clearTimeout(timeout)
            const text = await response.text()
            if (!response.ok) {
                fastify.log.warn({ category: 'MetadataProxy' }, `PMDB ${method} ${cleanPath} user ${maskContext(authUser)} upstream ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
                reply.status(response.status)
                try { return JSON.parse(text) } catch { return { error: `PMDB upstream error (${response.status})` } }
            }
            reply.header('Content-Type', 'application/json')
            return text || '{}'
        } catch (err) {
            const status = err?.name === 'AbortError' ? 504 : 502
            fastify.log.warn({ category: 'MetadataProxy' }, `PMDB ${method} ${request.params['*'] || ''} user ${maskContext(authUser)} request failed: ${_redactKey(err && err.message)}`)
            reply.status(status)
            return { error: 'PMDB request failed' }
        }
    }

    fastify.post('/api/metadata/pmdb/*', {
        config: { rateLimit: RATE_LIMIT_PMDB },
    }, async (request, reply) => pmdbMutate(request, reply, 'POST'))

    fastify.delete('/api/metadata/pmdb/*', {
        config: { rateLimit: RATE_LIMIT_PMDB },
    }, async (request, reply) => pmdbMutate(request, reply, 'DELETE'))

    const MDBLIST_BASE = 'https://mdblist.com/api'
    const TVDB_BASE = 'https://api4.thetvdb.com/v4'

    fastify.get('/api/metadata/mdblist/*', {
        config: { rateLimit: RATE_LIMIT_PROXY },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        const binding = authUser ? await workspaceBinding(authUser) : null
        if (binding === null) { reply.status(401); return { error: 'Unauthorized' } }

        let keyRecord
        try { keyRecord = await loadUserKey(authUser, 'mdblist', binding) } catch { reply.status(500); return { error: 'Key lookup failed' } }
        if (!keyRecord) { reply.status(401); return { error: 'MDBList key not configured' } }

        const wildcard = request.params['*'] || ''
        const pathParts = String(wildcard).split('/').filter(Boolean)
        if (pathParts.length === 0) { reply.status(400); return { error: 'Missing path' } }

        const incomingQuery = request.query && typeof request.query === 'object' ? request.query : {}
        const queryParts = []
        for (const [k, v] of Object.entries(incomingQuery)) {
            if (k && v !== undefined && v !== null) queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        }

        let url
        if (pathParts[0] === 'i' && pathParts[1]) {
            queryParts.push(`i=${encodeURIComponent(pathParts[1])}`)
            queryParts.push(`apikey=${keyRecord.key}`)
            url = `${MDBLIST_BASE}/?${queryParts.join('&')}`
        } else {
            const cleanPath = pathParts.map(encodeURIComponent).join('/')
            queryParts.push(`apikey=${keyRecord.key}`)
            url = `${MDBLIST_BASE}/${cleanPath}?${queryParts.join('&')}`
        }

        const mdbKeyQuery = Object.keys(incomingQuery)
            .filter(k => k && incomingQuery[k] !== undefined && incomingQuery[k] !== null)
            .sort()
            .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(incomingQuery[k]))}`)
            .join('&')
        const owner = { id: authUser, password: binding }
        const version = createHash('sha256').update(String(binding)).digest('hex')
        const cacheKey = JSON.stringify(['private-v2', authUser, version, 'mdblist', pathParts, mdbKeyQuery])

        try {
            const { value, hit } = await auxMetadataGet(cacheKey, async () => {
                const response = await resilientFetch(url, {
                    headers: { Accept: 'application/json' },
                    timeout: UPSTREAM_TIMEOUT_MS,
                    retries: UPSTREAM_RETRIES,
                })
                const text = await response.text()
                if (!response.ok) throw makeUpstreamError('MDBList', response.status)
                return text
            }, AUX_CACHE_TTL_DEFAULT, owner)
            reply.header('Content-Type', 'application/json')
            if (hit) reply.header('X-Cache', 'HIT')
            return value
        } catch (err) {
            const status = err?.status || (err?.name === 'AbortError' ? 504 : 502)
            reply.status(status)
            return { error: `MDBList upstream error (${status})` }
        }
    })

    fastify.get('/api/metadata/tvdb/*', {
        config: { rateLimit: RATE_LIMIT_PROXY },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        const binding = authUser ? await workspaceBinding(authUser) : null
        if (binding === null) { reply.status(401); return { error: 'Unauthorized' } }

        let keyRecord
        try { keyRecord = await loadUserKey(authUser, 'tvdb', binding) } catch { reply.status(500); return { error: 'Key lookup failed' } }
        if (!keyRecord) { reply.status(401); return { error: 'TVDB key not configured' } }

        const wildcard = request.params['*'] || ''
        const pathParts = String(wildcard).split('/').filter(Boolean)
        if (pathParts.length === 0) { reply.status(400); return { error: 'Missing path' } }

        const incomingQuery = request.query && typeof request.query === 'object' ? request.query : {}
        const queryString = Object.keys(incomingQuery)
            .filter(k => k && incomingQuery[k] !== undefined && incomingQuery[k] !== null)
            .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(incomingQuery[k]))}`)
            .join('&')
        const cleanPath = pathParts.map(encodeURIComponent).join('/')
        const url = queryString
            ? `${TVDB_BASE}/${cleanPath}?${queryString}`
            : `${TVDB_BASE}/${cleanPath}`

        const cacheKey = `tvdb:${authUser}:${url}`
        try {
            const { value, hit } = await auxMetadataGet(cacheKey, async () => {
                const response = await resilientFetch(url, {
                    headers: { Authorization: `Bearer ${keyRecord.key}`, Accept: 'application/json' },
                    timeout: UPSTREAM_TIMEOUT_MS,
                    retries: UPSTREAM_RETRIES,
                })
                const text = await response.text()
                if (!response.ok) throw makeUpstreamError('TVDB', response.status)
                return text
            })
            reply.header('Content-Type', 'application/json')
            if (hit) reply.header('X-Cache', 'HIT')
            return value
        } catch (err) {
            const status = err?.status || (err?.name === 'AbortError' ? 504 : 502)
            reply.status(status)
            return { error: `TVDB upstream error (${status})` }
        }
    })

    const FANART_BASE = 'https://webservice.fanart.tv/v3'

    fastify.get('/api/metadata/fanart/*', {
        config: { rateLimit: RATE_LIMIT_PROXY },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        const binding = authUser ? await workspaceBinding(authUser) : null
        if (binding === null) { reply.status(401); return { error: 'Unauthorized' } }

        let keyRecord
        try { keyRecord = await loadUserKey(authUser, 'fanart', binding) } catch { reply.status(500); return { error: 'Key lookup failed' } }
        if (!keyRecord) { reply.status(401); return { error: 'Fanart key not configured' } }

        const wildcard = request.params['*'] || ''
        const pathParts = String(wildcard).split('/').filter(Boolean)
        if (pathParts.length === 0) { reply.status(400); return { error: 'Missing path' } }

        const cleanPath = pathParts.map(encodeURIComponent).join('/')
        const url = `${FANART_BASE}/${cleanPath}?api_key=${keyRecord.key}`

        try {
            const { value, hit } = await auxMetadataGet(`fanart:${authUser}:${cleanPath}`, async () => {
                const response = await resilientFetch(url, {
                    headers: { Accept: 'application/json' },
                    timeout: UPSTREAM_TIMEOUT_MS,
                    retries: UPSTREAM_RETRIES,
                })
                const text = await response.text()
                if (!response.ok) throw makeUpstreamError('Fanart', response.status)
                return text
            })
            reply.header('Content-Type', 'application/json')
            if (hit) reply.header('X-Cache', 'HIT')
            return value
        } catch (err) {
            const status = err?.status || (err?.name === 'AbortError' ? 504 : 502)
            reply.status(status)
            return { error: `Fanart upstream error (${status})` }
        }
    })

    // ── AUDIENCE REVIEWS & COMMENTS AGGREGATOR ENDPOINT ──────────────────────
    fastify.get('/api/metadata/comments', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        const binding = authUser ? await workspaceBinding(authUser) : null
        if (binding === null) {
            reply.status(401); return { error: 'Unauthorized' }
        }

        const { imdbId, type, tmdbId } = request.query || {}
        if (!imdbId && !tmdbId) return []

        let tmdbKeyRecord = null
        if (authUser) {
            try { tmdbKeyRecord = await loadUserKey(authUser, 'tmdb', binding) } catch {}
        }

        const cacheKey = `comments:${imdbId || tmdbId}:${type || 'movie'}`

        const mediaPath = (type === 'series' || type === 'anime' || type === 'tv') ? 'shows' : 'movies'

        const buildComments = async () => {
            const comments = []
            const targetTmdbId = tmdbId || (imdbId && !imdbId.startsWith('tt') ? imdbId : null)
            let tmdbNumericId = targetTmdbId

            if (!tmdbNumericId && tmdbKeyRecord && imdbId && imdbId.startsWith('tt')) {
                try {
                    const findReq = buildTmdbRequest(['find', imdbId], 'external_source=imdb_id', tmdbKeyRecord.key, tmdbKeyRecord.format)
                    const findResult = await metadataCache.get(
                        buildCacheKey('tmdb', ['find', imdbId], 'external_source=imdb_id'),
                        () => fetchUpstream(findReq),
                        { ttl: DEFAULT_TTL_FIND_MS, ttlFromValue: findTtlFromValue }
                    )
                    const findData = findResult.value
                    const found = (findData.movie_results && findData.movie_results[0]) || (findData.tv_results && findData.tv_results[0])
                    if (found) tmdbNumericId = found.id
                } catch (err) {}
            }

            if (tmdbNumericId && tmdbKeyRecord) {
                try {
                    const tmdbType = (type === 'series' || type === 'anime' || type === 'tv') ? 'tv' : 'movie'
                    const reviewsReq = buildTmdbRequest([tmdbType, String(tmdbNumericId), 'reviews'], '', tmdbKeyRecord.key, tmdbKeyRecord.format)
                    const reviewsResult = await metadataCache.get(
                        buildCacheKey('tmdb', [tmdbType, String(tmdbNumericId), 'reviews'], ''),
                        () => fetchUpstream(reviewsReq),
                        { ttl: DEFAULT_TTL_DETAILS_MS }
                    )
                    const tmdbData = reviewsResult.value
                    if (Array.isArray(tmdbData.results)) {
                        for (const rv of tmdbData.results.slice(0, 20)) {
                            if (rv.content && rv.content.trim()) {
                                let avatar = rv.author_details?.avatar_path || undefined
                                if (avatar && avatar.startsWith('/https')) avatar = avatar.slice(1)
                                else if (avatar && avatar.startsWith('/')) avatar = `https://image.tmdb.org/t/p/w185${avatar}`

                                comments.push({
                                    id: `tmdb-${rv.id}`,
                                    author: rv.author || rv.author_details?.username || 'TMDB Reviewer',
                                    avatar,
                                    rating: typeof rv.author_details?.rating === 'number' ? rv.author_details.rating : undefined,
                                    content: rv.content.trim(),
                                    createdAt: rv.created_at || '',
                                    source: 'TMDB',
                                })
                            }
                        }
                    }
                } catch (err) {}
            }

            return comments
        }

        let comments = []
        if (tmdbKeyRecord) {
            try {
                const aggregate = await auxMetadataGet(cacheKey, buildComments)
                comments = aggregate.value
            } catch (err) {}
        }

        reply.header('Content-Type', 'application/json')
        return comments
    })
}
