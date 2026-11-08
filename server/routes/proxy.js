import { addonManifestUrl } from '../utils/addon-endpoint-url.js'
import { registerCacheLayer } from '../lib/ops-metrics.js'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AIOSTREAMS_USER_API_THROTTLE_MS, DATASTORE_META_BATCH_CONCURRENCY, DATASTORE_META_BATCH_ENTRY_TIMEOUT_MS, DATASTORE_META_BATCH_MAX, IMAGE_CACHE_MAX_BYTES, IMAGE_CACHE_MAX_ITEM_BYTES, IMAGE_CACHE_TTL_MS, IMAGE_PROXY_QUEUE_LIMIT, IMAGE_PROXY_THROTTLE_MS, IMAGE_PROXY_TIMEOUT_MS, STREMIO_API, VERSION } from '../config.js'
import { requireProxyAuth, verifyAuth } from '../auth.js'
import { enqueueProxyRequest } from '../proxy-queue.js'
import { isSafeUrl, isSafeUrlResolved } from '../utils/ssrf.js'
import { guardedWebFetch } from '../utils/safe-fetch.js'
import { deriveAddonName, maskContext, truncateUrl } from '../utils/log-helpers.js'
import { trace, keyTag, traceEnabled, hostOf } from '../utils/trace.js'
import { getAddonUrlKey } from '../utils/addon-url.js'
import { invalidateCanonicalAddons, invalidateCanonicalByAuthKey } from '../hydra/canonical-cache.js'
import { PRIMARY_KEY } from '../keys.js'
import { AVATAR_ALLOWED_TYPES, AVATAR_BUDGET_BYTES, AVATAR_CACHE_CONTROL, AVATAR_MAX_BYTES, AVATAR_SIGN_BATCH_MAX, IMMUTABLE_CACHE_CONTROL, clampImageWidth, createByteBudget, declaredTypeConflicts, detectImageType, metahubVariantUrl, signAvatarUrl, verifyAvatarSignature } from '../utils/image-variants.js'

export const briefAddons = (addons) => (Array.isArray(addons) ? addons.map(a => ({ id: a?.manifest?.id || a?.id || '?', host: a?.transportUrl ? hostOf(a.transportUrl) : '' })) : [])

const SHRINK_GUARD_RATIO = 0.25
const isSuspiciousShrink = (previousCount, nextCount) => (
    previousCount > 0 && nextCount < Math.ceil(previousCount * SHRINK_GUARD_RATIO)
)
export { isSuspiciousShrink }

// DatastoreMeta is used both by the normal proxy route and by the batch route.
// One process-wide permit pool keeps the two paths from multiplying upstream
// fan-out, and a fixed per-owner cap keeps one owner from holding every permit.
// Waiters are cancellable: a disconnected request is removed before it can
// consume a permit.
const META_UPSTREAM_GLOBAL = Math.max(8, DATASTORE_META_BATCH_CONCURRENCY * 2)
const META_UPSTREAM_PER_OWNER = 8
const META_QUEUE_WAIT_MS = 10000
const metaUpstreamWaiters = []
const activeMetaByOwner = new Map()
let activeMetaUpstream = 0
const acquireMetaUpstream = (owner, signal) => new Promise((resolve) => {
    let settled = false
    const waiter = () => {
        if (settled) return
        if (signal?.aborted) {
            settled = true
            signal.removeEventListener('abort', onAbort)
            resolve(null)
            return
        }
        if (activeMetaUpstream >= META_UPSTREAM_GLOBAL || (activeMetaByOwner.get(owner) || 0) >= META_UPSTREAM_PER_OWNER) {
            metaUpstreamWaiters.push(waiter)
            return
        }
        settled = true
        signal?.removeEventListener('abort', onAbort)
        activeMetaUpstream++
        activeMetaByOwner.set(owner, (activeMetaByOwner.get(owner) || 0) + 1)
        let released = false
        resolve(() => {
            if (released) return
            released = true
            activeMetaUpstream = Math.max(0, activeMetaUpstream - 1)
            const left = (activeMetaByOwner.get(owner) || 1) - 1
            if (left > 0) activeMetaByOwner.set(owner, left)
            else activeMetaByOwner.delete(owner)
            for (const next of metaUpstreamWaiters.splice(0)) next()
        })
    }
    const onAbort = () => {
        if (settled) return
        settled = true
        const index = metaUpstreamWaiters.indexOf(waiter)
        if (index >= 0) metaUpstreamWaiters.splice(index, 1)
        signal?.removeEventListener('abort', onAbort)
        resolve(null)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    waiter()
})

const isValidMetaRows = (rows) => {
    if (!Array.isArray(rows)) return false
    const ids = new Set()
    return rows.every(row => {
        if (!Array.isArray(row) || row.length !== 2) return false
        const [id, mtime] = row
        if (typeof id !== 'string' || id.length === 0 || ids.has(id)) return false
        if (!Number.isSafeInteger(mtime) || mtime < 0) return false
        ids.add(id)
        return true
    })
}

export function registerProxyRoutes(fastify, { checkAddonHealthInternal }) {
    const manifestCache = new Map()
    const MANIFEST_CACHE_TTL = 600000 // 10 minutes
    const MANIFEST_NEGATIVE_TTL = 60000
    const MANIFEST_NEGATIVE_MAX = 1000

    const imageCache = new Map()
    const imageInflight = new Map()
    let imageCacheBytes = 0
    const imageCacheStats = { hits: 0, misses: 0, evictions: 0 }

    const normalizeImageKey = (rawUrl) => {
        try {
            const u = new URL(rawUrl)
            if (u.hostname === 'live.metahub.space' || u.hostname === 'images.metahub.space') {
                u.hostname = 'images.metahub.space'
            }
            return u.href
        } catch {
            return rawUrl
        }
    }

    const imageCacheGet = (key) => {
        const hit = imageCache.get(key)
        if (!hit) { imageCacheStats.misses++; return null }
        if (hit.expires <= Date.now()) {
            imageCache.delete(key)
            imageCacheBytes -= hit.bytes
            imageCacheStats.misses++
            return null
        }
        imageCacheStats.hits++
        imageCache.delete(key)
        imageCache.set(key, hit)
        return hit
    }

    const imageCacheSet = (key, buffer, contentType) => {
        if (IMAGE_CACHE_MAX_BYTES <= 0 || buffer.length > IMAGE_CACHE_MAX_ITEM_BYTES) return
        const existing = imageCache.get(key)
        if (existing) { imageCache.delete(key); imageCacheBytes -= existing.bytes }
        const entry = { buffer, contentType, expires: Date.now() + IMAGE_CACHE_TTL_MS, bytes: buffer.length }
        imageCache.set(key, entry)
        imageCacheBytes += entry.bytes
        while (imageCacheBytes > IMAGE_CACHE_MAX_BYTES && imageCache.size > 0) {
            const oldestKey = imageCache.keys().next().value
            const oldest = imageCache.get(oldestKey)
            imageCache.delete(oldestKey)
            imageCacheBytes -= oldest.bytes
            imageCacheStats.evictions++
        }
    }
    registerCacheLayer('image', { label: 'Poster image cache', stats: () => ({ ...imageCacheStats, entries: imageCache.size, bytes: imageCacheBytes, maxBytes: IMAGE_CACHE_MAX_BYTES, inflight: imageInflight.size }) })
    registerCacheLayer('manifest', { label: 'Addon manifest cache', stats: () => ({ entries: manifestCache.size }) })
    const lastGoodAddonCollections = new Map()
    const MAX_TRACKED_COLLECTIONS = 2500
    const STREMIO_PROXY_CLIENT_BUDGET_MS = 30000
    const STREMIO_PROXY_MIN_ATTEMPT_MS = 2000
    const MAX_ADDON_COLLECTION_SIZE = 250
    const PROFILE_SWAP_CONTEXT = 'Profile Swap'
    const ADDON_REFRESH_ERROR_PATTERN = /AddonsPulledFromAPI|UserAddonsLocked|manifest.*missing field|upstream returned 403|forbidden|access denied|status\s*403|\b403\b/i

    const getAIOStreamsAuthHeader = (uuid, password) => `Basic ${Buffer.from(`${uuid}:${password}`, 'utf8').toString('base64')}`

    const readAIOStreamsJson = async (response) => {
        try {
            return await response.json()
        } catch {
            return { success: false, error: { message: 'AIOStreams returned an invalid response' } }
        }
    }

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

    const getRetryAfterMs = (response) => {
        const retryAfter = response.headers.get('retry-after')
        if (!retryAfter) return null
        const seconds = Number(retryAfter)
        if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, 30000))
        const retryDate = Date.parse(retryAfter)
        if (Number.isNaN(retryDate)) return null
        return Math.max(0, Math.min(retryDate - Date.now(), 30000))
    }

    const getAIOStreamsQueueOptions = (url) => {
        let origin = url
        try { origin = new URL(url).origin } catch { }
        return {
            queueKey: `aiostreams-user:${origin}`,
            throttleMs: AIOSTREAMS_USER_API_THROTTLE_MS,
        }
    }

    const fetchAIOStreamsJson = async (url, options = {}) => {
        const { rateLimitRetries = 2, ...fetchOptions } = options
        for (let attempt = 0; attempt <= rateLimitRetries; attempt++) {
            const response = await enqueueProxyRequest(url, async () => {
                const controller = new AbortController()
                const timeout = setTimeout(() => controller.abort(), 10000)
                try {
                    return await guardedWebFetch(url, {
                        ...fetchOptions,
                        signal: controller.signal,
                        redirect: 'manual',
                    })
                } finally {
                    clearTimeout(timeout)
                }
            }, getAIOStreamsQueueOptions(url))
            const json = await readAIOStreamsJson(response)

            if (response.status !== 429 || attempt >= rateLimitRetries) {
                return { response, json }
            }

            const retryMs = getRetryAfterMs(response) ?? (2500 * (attempt + 1))
            fastify.log.warn({ category: 'AIOStreamsProxy' }, `AIOStreams rate limited ${truncateUrl(url)}; retrying in ${retryMs}ms.`)
            await sleep(retryMs)
        }
    }

    const sanitizeAddonForStremio = (addon) => {
        const manifest = addon?.manifest || {}
        const url = String(addon?.transportUrl || '')
        const id = manifest.id || `managed-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`
        return {
            ...addon,
            manifest: {
                ...manifest,
                id,
                name: manifest.name || deriveAddonName(url),
                version: manifest.version || '0.0.0'
            }
        }
    }
    const hasKeys = (value) => value && Object.keys(value).length > 0
    const withoutUndefined = (value) => Object.fromEntries(
        Object.entries(value || {}).filter(([, entry]) => entry !== undefined)
    )

    const mergeDuplicateAddon = (existing, incoming) => {
        const flags = {
            ...(incoming.flags || {}),
            ...(existing.flags || {}),
        }
        const metadata = {
            ...withoutUndefined(existing.metadata),
            ...withoutUndefined(incoming.metadata),
        }
        return {
            ...existing,
            ...incoming,
            transportUrl: incoming.transportUrl || existing.transportUrl,
            manifest: incoming.manifest || existing.manifest,
            flags: hasKeys(flags) ? flags : undefined,
            metadata: hasKeys(metadata) ? metadata : undefined,
            catalogOverrides: incoming.catalogOverrides || existing.catalogOverrides,
            note: incoming.note ?? existing.note,
            syncToLibrary: incoming.syncToLibrary ?? existing.syncToLibrary,
        }
    }

    const dedupeAddonCollectionByTransportUrl = (addons) => {
        const result = []
        const indexByUrl = new Map()
        for (const addon of addons) {
            const key = getAddonUrlKey(addon?.transportUrl)
            if (!key) {
                result.push(addon)
                continue
            }
            const existingIndex = indexByUrl.get(key)
            if (existingIndex === undefined) {
                indexByUrl.set(key, result.length)
                result.push(addon)
                continue
            }
            result[existingIndex] = mergeDuplicateAddon(result[existingIndex], addon)
        }
        return result
    }

    const getAuthCollectionKey = (authKey) => {
        if (!authKey || typeof authKey !== 'string') return null
        return createHash('sha256').update(authKey).digest('hex')
    }

    const returnLastGoodCollection = (authKey, reason, acct = null) => {
        const lastGood = getLastGoodCollection(authKey)
        if (!lastGood?.length) return null
        fastify.log.warn({ category: 'Sync', fmt: 'sync.last_good', acct, reason: 'upstream-error' }, `[Proxy] Returning last-good addon collection after ${reason}`)
        trace('proxy.get', 'served-last-good', { key: keyTag(authKey), reason, count: lastGood.length, addons: traceEnabled() ? briefAddons(lastGood) : undefined })
        return { result: { addons: lastGood, lastModified: Date.now() }, recoveredFromLastGood: true }
    }

    const rememberGoodCollection = (authKey, addons, { allowEmpty = false } = {}) => {
        const key = getAuthCollectionKey(authKey)
        if (!key || !Array.isArray(addons) || (addons.length === 0 && !allowEmpty)) return
        if (lastGoodAddonCollections.has(key)) {
            lastGoodAddonCollections.delete(key)
        } else if (lastGoodAddonCollections.size >= MAX_TRACKED_COLLECTIONS) {
            const oldest = lastGoodAddonCollections.keys().next().value
            if (oldest) lastGoodAddonCollections.delete(oldest)
        }
        lastGoodAddonCollections.set(key, {
            addons: addons.map(sanitizeAddonForStremio),
            ts: Date.now(),
        })
    }

    const getLastGoodCollection = (authKey) => {
        const key = getAuthCollectionKey(authKey)
        return key ? lastGoodAddonCollections.get(key)?.addons || null : null
    }

    const validateAddonCollection = (addons) => {
        if (!Array.isArray(addons)) return 'Addon collection must be an array'
        if (addons.length > MAX_ADDON_COLLECTION_SIZE) return `Addon collection exceeds ${MAX_ADDON_COLLECTION_SIZE} entries`
        for (let i = 0; i < addons.length; i++) {
            const addon = addons[i]
            if (!addon?.transportUrl) return `addons[${i}] is missing transportUrl`
            try {
                const parsed = new URL(String(addon.transportUrl).replace(/^stremio:\/\//i, 'https://'))
                if (!['http:', 'https:'].includes(parsed.protocol)) return `addons[${i}] has unsupported URL protocol`
            } catch {
                return `addons[${i}] has invalid transportUrl`
            }
            if (!addon.manifest?.id || !addon.manifest?.name || !addon.manifest?.version) {
                return `addons[${i}].manifest is missing required fields`
            }
        }
        return null
    }

    const manifestNegative = new Map()
    const manifestInflight = new Map()
    const discoverInflight = new Map()

    const manifestCacheGet = (url) => {
        const cached = manifestCache.get(url)
        return cached && Date.now() - cached.ts < MANIFEST_CACHE_TTL ? cached : null
    }

    const manifestNegativeGet = (url) => {
        const hit = manifestNegative.get(url)
        if (!hit) return null
        if (hit.expires <= Date.now()) {
            manifestNegative.delete(url)
            return null
        }
        return hit.result
    }

    const manifestNegativeSet = (url, result) => {
        manifestNegative.delete(url)
        manifestNegative.set(url, { result, expires: Date.now() + MANIFEST_NEGATIVE_TTL })
        while (manifestNegative.size > MANIFEST_NEGATIVE_MAX) {
            const oldestKey = manifestNegative.keys().next().value
            if (oldestKey === undefined) break
            manifestNegative.delete(oldestKey)
        }
    }

    // Resolves to { status, body, contentType? } so one upstream fetch can answer many replies.
    const fetchManifestUpstream = (url, authorization, shareable) => enqueueProxyRequest(url, async () => {
        if (shareable) {
            const cached = manifestCacheGet(url)
            if (cached) return { status: 200, body: cached.buffer, contentType: cached.contentType }
            const negative = manifestNegativeGet(url)
            if (negative) return negative
        }
        const failed = (result) => {
            if (shareable) manifestNegativeSet(url, result)
            return result
        }
        let redirected = false
        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 6000)

            const MAX_REDIRECTS = 3
            const originOf = (u) => { try { return new URL(u).origin } catch { return '' } }
            const startOrigin = originOf(url)
            let currentUrl = url
            let response
            try {
                for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
                    response = await guardedWebFetch(currentUrl, {
                        signal: controller.signal,
                        redirect: 'manual',
                        maxBytes: 5 * 1024 * 1024,
                        headers: {
                            'User-Agent': `AIOManager/${VERSION} (Internal Proxy; Hardened)`,
                            'Accept': 'application/json, text/plain, */*',
                            ...(authorization && originOf(currentUrl) === startOrigin ? { 'Authorization': authorization } : {})
                        }
                    })

                    if (response.status >= 300 && response.status < 400) {
                        const location = response.headers.get('location')
                        if (!location) break
                        const resolvedUrl = new URL(location, currentUrl).href
                        if (!isSafeUrl(resolvedUrl)) {
                            return { status: 403, body: { error: 'Access Denied: Unsafe redirect target' } }
                        }
                        currentUrl = resolvedUrl
                        redirected = true
                        continue
                    }
                    break
                }
            } finally {
                clearTimeout(timeout)
            }

            if (!response.ok) {
                if (response.status === 404 || response.status === 410) manifestCache.delete(url)
                return failed({ status: response.status, body: { error: `Upstream returned ${response.status}` } })
            }

            const contentType = response.headers.get('content-type') || ''
            if (contentType.startsWith('video/') || contentType.startsWith('audio/')) {
                return { status: 415, body: { error: 'Unsupported Media Type' } }
            }

            const contentLength = parseInt(response.headers.get('content-length') || '0')
            if (contentLength > 5 * 1024 * 1024) {
                return { status: 413, body: { error: 'Payload Too Large (>5MB)' } }
            }

            // FIX: Fastify/Compress doesn't handle Web ReadableStream well, convert to Buffer
            const arrayBuffer = await response.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)

            if (buffer.length > 5 * 1024 * 1024) {
                return { status: 413, body: { error: 'Payload Too Large (>5MB)' } }
            }

            if (manifestCache.size > 5000) {
                const now = Date.now()
                for (const [k, v] of manifestCache) {
                    if (now - v.ts > MANIFEST_CACHE_TTL) manifestCache.delete(k)
                }
                while (manifestCache.size > 4000) {
                    const oldestKey = manifestCache.keys().next().value
                    if (oldestKey === undefined) break
                    manifestCache.delete(oldestKey)
                }
            }
            if (shareable) {
                manifestCache.set(url, { buffer, contentType: contentType || null, ts: Date.now() })
                manifestNegative.delete(url)
            }

            return { status: 200, body: buffer, contentType: contentType || null }
        } catch (err) {
            if (err.code === 'ssrf-blocked') {
                return { status: 403, body: { error: redirected ? 'Access Denied: Unsafe redirect target' : 'Access Denied: Unsafe URL' } }
            }
            if (err.code === 'too-large') {
                return { status: 413, body: { error: 'Payload Too Large (>5MB)' } }
            }
            if (err.name === 'AbortError') {
                fastify.log.error({ category: 'MetaProxy' }, `Timeout after 6s: ${truncateUrl(url)}`)
                return failed({ status: 504, body: { error: 'Gateway Timeout', details: 'Upstream addon took too long to respond (>6s)' } })
            }
            fastify.log.error({ category: 'MetaProxy' }, `Failed to fetch ${truncateUrl(url)}: ${err.message}`)
            return failed({ status: 500, body: { error: 'Internal Proxy Error', details: 'Internal error' } })
        }
    })

    fastify.get('/api/meta-proxy', {
        config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
        schema: {
            querystring: {
                type: 'object',
                required: ['url'],
                properties: {
                    url: { type: 'string' }
                }
            }
        }
    }, async (request, reply) => {
        const authResult = await requireProxyAuth(request, reply)
        if (authResult) return authResult

        const { url } = request.query
        const accountContext = request.headers['x-account-context'] || 'Unknown'

        if (!isSafeUrl(url)) {
            fastify.log.warn({ category: 'Security' }, `blocked unsafe proxy request: ${truncateUrl(url)}`)
            reply.status(403);
            return { error: 'Access Denied: Unsafe URL' }
        }

        // The shared caches are keyed by url only, so an authenticated upstream response
        // (caller forwards a provider Bearer key for provider-config endpoints) must never be
        // cached, shared in flight, or negative-cached cross-user. Bypass all of them when
        // Authorization is present; public manifests still cache and stay shareable.
        const authorization = request.headers['authorization']
        const shareable = !authorization && request.query.nocache !== '1'

        if (shareable) {
            const cached = manifestCacheGet(url)
            if (cached) {
                if (cached.contentType) reply.type(cached.contentType)
                reply.header('Cache-Control', 'public, max-age=300')
                return cached.buffer
            }
            const negative = manifestNegativeGet(url)
            if (negative) {
                reply.status(negative.status)
                return negative.body
            }
        }

        let pending = shareable ? manifestInflight.get(url) : undefined
        if (!pending) {
            fastify.log.info({ category: 'MetaProxy' }, `[${maskContext(accountContext)}] Proxying request to: ${truncateUrl(url)}`)
            pending = fetchManifestUpstream(url, authorization, shareable)
            if (shareable) {
                pending = pending.finally(() => manifestInflight.delete(url))
                manifestInflight.set(url, pending)
            }
        }

        const result = await pending
        if (result.status !== 200) {
            reply.status(result.status)
            return result.body
        }
        if (result.contentType) reply.type(result.contentType)
        if (shareable) reply.header('Cache-Control', 'public, max-age=300')
        return result.body
    })

    const avatarBudget = createByteBudget({ limit: Number(process.env.AIOM_AVATAR_BUDGET_BYTES) || AVATAR_BUDGET_BYTES })

    fastify.post('/api/proxy-image/sign', {
        bodyLimit: 256 * 1024,
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object',
                required: ['urls'],
                properties: {
                    urls: { type: 'array', maxItems: AVATAR_SIGN_BATCH_MAX, items: { type: 'string', maxLength: 2048 } }
                }
            }
        }
    }, async (request, reply) => {
        const authResult = await requireProxyAuth(request, reply)
        if (authResult) return authResult
        const userId = request.deviceAuth?.accountUuid || request.headers['x-sync-user']
        const items = request.body.urls.map((raw) => {
            if (!isSafeUrl(raw)) return null
            return signAvatarUrl(PRIMARY_KEY, userId, raw)
        })
        return { items }
    })

    fastify.get('/api/proxy-image', {
        config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
        schema: {
            querystring: {
                type: 'object',
                required: ['url'],
                properties: {
                    url: { type: 'string' },
                    w: { type: 'string', maxLength: 8 },
                    kind: { type: 'string', enum: ['avatar'] },
                    u: { type: 'string', maxLength: 32 },
                    exp: { type: 'string', maxLength: 16 },
                    sig: { type: 'string', maxLength: 64 }
                }
            }
        }
    }, async (request, reply) => {
        const ALLOWED_IMAGE_DOMAINS = ['metahub.space', 'strem.io']
        const { url: queryUrl, w, kind, u: userTag, exp, sig } = request.query
        const isAvatar = kind === 'avatar'
        if (isAvatar && !verifyAvatarSignature(PRIMARY_KEY, { url: queryUrl, u: userTag, exp, sig, w })) {
            reply.status(401)
            return { error: 'Signed avatar URL required' }
        }
        const maxImageBytes = isAvatar ? AVATAR_MAX_BYTES : 10 * 1024 * 1024
        const rawUrl = isAvatar ? queryUrl : metahubVariantUrl(queryUrl, clampImageWidth(w))

        const isAllowedImageHost = (host) => ALLOWED_IMAGE_DOMAINS.some(domain => host === domain || host.endsWith('.' + domain))

        let parsedHost
        try {
            const parsed = new URL(rawUrl)
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol')
            parsedHost = parsed.hostname
        } catch {
            reply.status(403)
            return { error: 'Invalid URL' }
        }

        if (!isAvatar && !isAllowedImageHost(parsedHost)) {
            reply.status(403)
            return { error: 'Domain not allowed' }
        }

        let candidates = [rawUrl]
        if (parsedHost === 'live.metahub.space' || parsedHost === 'images.metahub.space') {
            const primary = new URL(rawUrl); primary.hostname = 'images.metahub.space'
            const secondary = new URL(rawUrl); secondary.hostname = 'live.metahub.space'
            candidates = [primary.href, secondary.href]
        }

        const fetchImage = async (startUrl, chain) => {
            const controller = new AbortController()
            // The budget covers the upstream exchange only: time spent waiting in the shared
            // queue must not abort a poster that never got a turn.
            let timeout = null
            // The queue wait itself is capped too, so a poster cannot sit in a backed-up queue indefinitely.
            const queueDeadline = Date.now() + IMAGE_PROXY_TIMEOUT_MS * 3
            try {
                let currentUrl = startUrl
                let response
                const MAX_REDIRECTS = 3
                let body = null

                for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
                    if (!isSafeUrl(currentUrl)) {
                        return { error: 'Access Denied: Unsafe URL', status: 403 }
                    }
                    if (chain.remaining <= 0) return { error: 'Payload Too Large', status: 413 }
                    try {
                        response = await enqueueProxyRequest(currentUrl, async () => {
                            if (Date.now() > queueDeadline) throw Object.assign(new Error('Image proxy queue wait exceeded'), { code: 'queue-timeout' })
                            if (!timeout) timeout = setTimeout(() => controller.abort(), IMAGE_PROXY_TIMEOUT_MS)
                            return guardedWebFetch(currentUrl, {
                                signal: controller.signal,
                                redirect: 'manual',
                                maxBytes: chain.remaining,
                                headers: {
                                    'User-Agent': `AIOManager/${VERSION} (Image Proxy)`,
                                    'Accept': 'image/*'
                                }
                            })
                        }, { queueKey: 'image-proxy', maxPerKey: IMAGE_PROXY_QUEUE_LIMIT, throttleMs: IMAGE_PROXY_THROTTLE_MS, deadline: queueDeadline })
                    } catch (err) {
                        if (err.code === 'ssrf-blocked') return { error: 'Access Denied: Unsafe URL', status: 403 }
                        if (err.code === 'queue-timeout') return { error: 'Upstream timeout', status: 504 }
                        if (err.code === 'too-large') { chain.used += chain.remaining; chain.remaining = 0; return { error: 'Payload Too Large', status: 413 } }
                        throw err
                    }

                    body = Buffer.from(await response.arrayBuffer())
                    chain.used += body.length
                    chain.remaining -= body.length

                    if (response.status >= 300 && response.status < 400) {
                        const location = response.headers.get('location')
                        if (!location) return { error: 'Missing redirect location', status: 502 }
                        currentUrl = new URL(location, currentUrl).href
                        continue
                    }
                    break
                }

                if (!response.ok || response.status >= 300) {
                    return { error: `Upstream returned ${response.status}`, status: 502 }
                }

                const buffer = body
                if (buffer.length > maxImageBytes) {
                    return { error: 'Payload Too Large', status: 413 }
                }

                const detected = detectImageType(buffer)
                if (!detected || declaredTypeConflicts(response.headers.get('content-type'), detected)) {
                    return { error: 'Unsupported image type', status: 415 }
                }
                if (isAvatar && !AVATAR_ALLOWED_TYPES.has(detected)) {
                    return { error: 'Unsupported image type', status: 415 }
                }

                return { buffer, contentType: detected }
            } finally {
                if (timeout) clearTimeout(timeout)
            }
        }

        const cacheKey = (isAvatar ? 'avatar:' : '') + normalizeImageKey(rawUrl)
        const sendImage = (contentType, buffer, cacheState) => {
            reply.header('Cache-Control', isAvatar ? AVATAR_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL)
            reply.header('X-Content-Type-Options', 'nosniff')
            reply.header('Content-Disposition', 'inline')
            reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
            reply.header('X-Image-Cache', cacheState)
            reply.type(contentType)
            return buffer
        }

        const cached = imageCacheGet(cacheKey)
        if (cached) return sendImage(cached.contentType, cached.buffer, 'HIT')

        let resolution = imageInflight.get(cacheKey)
        if (!resolution) {
            const budgetReserve = isAvatar ? Math.min(maxImageBytes, Math.ceil(avatarBudget.limit / 10)) : 0
            if (isAvatar && !avatarBudget.reserve(userTag, budgetReserve)) {
                reply.status(429)
                return { error: 'Avatar fetch budget exceeded' }
            }
            resolution = (async () => {
                const chain = { remaining: maxImageBytes, used: 0 }
                try {
                    let lastFailure = { error: 'Image Proxy Error', status: 502 }
                    for (const candidate of candidates) {
                        let result
                        try {
                            result = await fetchImage(candidate, chain)
                        } catch (err) {
                            fastify.log.warn({ category: 'Proxy' }, `Image proxy attempt failed for ${isAvatar ? 'avatar' : truncateUrl(candidate)}: ${err.message}`)
                            lastFailure = { error: 'Image Proxy Error', status: 502 }
                            continue
                        }
                        if (result.buffer) {
                            imageCacheSet(cacheKey, result.buffer, result.contentType)
                            return result
                        }
                        lastFailure = result
                    }
                    return lastFailure
                } finally {
                    if (isAvatar) avatarBudget.settle(userTag, budgetReserve, chain.used)
                }
            })()
            imageInflight.set(cacheKey, resolution)
            resolution.finally(() => imageInflight.delete(cacheKey))
        }

        const result = await resolution
        if (result.buffer) return sendImage(result.contentType, result.buffer, 'MISS')

        reply.status(result.status)
        return { error: result.error }
    })

    fastify.post('/api/stremio-proxy', {
        bodyLimit: 1024 * 1024,
        config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object',
                required: ['type'],
                additionalProperties: true
            }
        }
    }, async (request, reply) => {
        const authResult = await requireProxyAuth(request, reply)
        if (authResult) return authResult

        const { type, ...payload } = request.body
        const accountContext = request.headers['x-account-context'] || 'Unknown'
        const masked = maskContext(accountContext)
        // Ring-bound account id: the authenticated device or sync user, never the client-typed
        // x-account-context header. The ring hashes it; maskContext stays stdout-only.
        const syncUserHeader = request.headers['x-sync-user']
        const ringAcct = request.deviceAuth?.accountUuid || (typeof syncUserHeader === 'string' && syncUserHeader ? syncUserHeader : null)
        // Client writes land on Stremio before their E2E sync blob; the reconciler must not re-assert the stale hub over them.
        if (type === 'AddonCollectionSet') {
            if (!fastify.clientCollectionWrites) fastify.clientCollectionWrites = new Map()
            fastify.clientCollectionWrites.set(accountContext, Date.now())
        }

        const actionMap = {
            'AddonCollectionGet': 'Refreshing Addons',
            'AddonCollectionSet': 'Pushing Addon Updates',
            'DatastoreGet': 'Syncing Library',
            'DatastorePut': 'Updating Library Items',
            'DatastoreMeta': 'Checking Library Changes',
            'GetUser': 'Fetching User Profile',
            'GetProfilesAddons': 'Fetching Sub-Profile Addons',
            'SetProfileAddons': 'Updating Sub-Profile Addons'
        }

        const PREMIUM_PREFS_PATHS = {
            'GetProfilesAddons': 'premiumPrefs/getProfilesAddons',
            'SetProfileAddons': 'premiumPrefs/setProfileAddons'
        }

        const friendlyAction = actionMap[type] || `Operation: ${type}`
        const SYNC_ACTIONS = {
            'AddonCollectionGet': 'pull',
            'AddonCollectionSet': 'push',
            'DatastoreGet': 'library-get',
            'DatastorePut': 'library-put',
            'DatastoreMeta': 'library-meta',
            'GetUser': 'user-get',
            'GetProfilesAddons': 'profile-get',
            'SetProfileAddons': 'profile-set',
        }
        const allowCollectionShrink = type === 'AddonCollectionSet' && payload.allowCollectionShrink === true && (accountContext === 'Profile Swap' || accountContext === 'Bulk Op' || accountContext === 'Clear All')
        delete payload.allowCollectionShrink

        if (type === 'AddonCollectionGet' || type === 'AddonCollectionSet' || type === 'DatastoreGet' || type === 'DatastorePut' || type === 'DatastoreMeta' || type === 'GetUser' || type === 'GetProfilesAddons' || type === 'SetProfileAddons') {
            fastify.log.info({ category: 'Sync', fmt: 'sync.action', action: SYNC_ACTIONS[type], acct: ringAcct, platform: 'stremio' }, `[${masked}] ${friendlyAction}...`)
        } else {
            // Strict Whitelist: Block unknown methods to prevent abuse
            fastify.log.warn({ category: 'Security' }, `[Proxy] Blocked unauthorized Stremio API call: ${type}`)
            reply.status(403);
            return { error: 'Method Not Allowed' }
        }

        // Stremio rejects addon collections when any embedded manifest is partial.
        // Fill required fields before forwarding so one blocked addon cannot poison the account.
        if (type === 'AddonCollectionSet' && Array.isArray(payload.addons)) {
            payload.addons = dedupeAddonCollectionByTransportUrl(payload.addons.map(addon => sanitizeAddonForStremio({ ...addon, transportUrl: addonManifestUrl(addon.transportUrl) })))
            const validationError = validateAddonCollection(payload.addons)
            if (validationError) {
                fastify.log.warn({ category: 'Security' }, `[Proxy] Blocked invalid AddonCollectionSet: ${validationError}`)
                reply.status(400)
                return { error: `Invalid addon collection: ${validationError}` }
            }

            const lastGood = getLastGoodCollection(payload.authKey)
            const wouldBlock = !allowCollectionShrink && isSuspiciousShrink(lastGood?.length || 0, payload.addons.length)
            trace('proxy.set', 'incoming', { key: keyTag(payload.authKey), context: String(accountContext), allowCollectionShrink, lastGood: lastGood?.length || 0, pushing: payload.addons.length, blocked: wouldBlock, addons: traceEnabled() ? briefAddons(payload.addons) : undefined })
            if (wouldBlock) {
                fastify.log.warn({ category: 'Security' }, `[Proxy] Blocked suspicious AddonCollectionSet shrink: ${lastGood.length} -> ${payload.addons.length}`)
                trace('proxy.set', 'blocked-shrink', { context: String(accountContext), lastGood: lastGood?.length || 0, pushing: payload.addons.length })
                reply.status(409)
                return { error: `Suspicious addon collection shrink blocked (${lastGood.length} → ${payload.addons.length})` }
            }
        }

        // Stremio library items must have valid ISO dates, and StremThru's Go-based worker 
        // crashes if deleted items (tombstones) have missing or empty timestamp strings.
        if (type === 'DatastorePut' && payload.collection === 'libraryItem' && Array.isArray(payload.changes)) {
            payload.changes = payload.changes.map(item => {
                if (item.removed) {
                    return {
                        ...item,
                        _ctime: item._ctime || '0001-01-01T00:00:00Z',
                        _mtime: item._mtime || '0001-01-01T00:00:00Z'
                    }
                }
                return item
            })
        }

        // A full-replace write may have landed before a timeout or upstream error.
        // Its caller must read back before deciding whether to retry.
        const MAX_RETRIES = (type === 'DatastorePut' || type === 'AddonCollectionSet') ? 0 : 2
        let lastError = null
        const requestStart = Date.now()
        let clientGone = Boolean(request.raw.aborted)
        let activeController = null
        const onClientGone = () => { clientGone = true; activeController?.abort() }
        request.raw.once('aborted', onClientGone)
        const onReplyClose = () => { if (!reply.raw.writableEnded) onClientGone() }
        reply.raw.once('close', onReplyClose)
        const withinClientBudget = (nextAttempt) => Date.now() - requestStart + 1000 * nextAttempt + STREMIO_PROXY_MIN_ATTEMPT_MS <= STREMIO_PROXY_CLIENT_BUDGET_MS
        // update:true re-fetches every manifest; when that refresh is rejected, the stored collection is still readable.
        let storedFallback = false
        let skipBackoff = false
        const canFallBackToStored = (attempt) => type === 'AddonCollectionGet' && !storedFallback && payload.update !== false && attempt < MAX_RETRIES && !clientGone
        const bustHydraCache = () => {
            invalidateCanonicalByAuthKey(payload.authKey)
            const syncUser = request.deviceAuth?.accountUuid || request.headers['x-sync-user']
            const accountId = String(accountContext).replace(/: rollback$/, '')
            if (syncUser && accountId && accountId !== 'Unknown') invalidateCanonicalAddons(accountId, String(syncUser))
        }

        try {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0 && clientGone) break
            const controller = new AbortController()
            activeController = controller
            const timeoutId = setTimeout(() => controller.abort(), 30000)
            const onRequestAborted = () => controller.abort()
            if (request.raw.aborted || clientGone) controller.abort()
            else request.raw.once('aborted', onRequestAborted)

            try {
                if (attempt > 0 && !skipBackoff) {
                    fastify.log.warn({ category: 'Sync' }, `[Proxy] Retrying Stremio API ${type} (Attempt ${attempt + 1}/${MAX_RETRIES + 1})...`)
                    await new Promise(r => setTimeout(r, 1000 * attempt))
                    // The client may have left during the backoff; never fetch upstream for it.
                    if (clientGone) { clearTimeout(timeoutId); break }
                }
                skipBackoff = false
                const upstreamPayload = storedFallback ? { ...payload, update: false } : payload

                const apiPath = PREMIUM_PREFS_PATHS[type] || (type.charAt(0).toLowerCase() + type.slice(1))
                if (type === 'AddonCollectionSet' && traceEnabled()) {
                    fastify.log.warn({ category: 'DebugTrace' }, `[DebugTrace] Set forward: apiPath=${apiPath} addons=${Array.isArray(payload.addons) ? payload.addons.length : 'none'} urls=${Array.isArray(payload.addons) ? payload.addons.slice(0, 3).map(a => (a.transportUrl || '').slice(0, 40)).join(' | ') : '-'}`)
                }
                let releaseMeta = null
                let metaTimeoutId = null
                if (type === 'DatastoreMeta') {
                    // Queue time has its own deadline; the upstream timer starts once a permit is held.
                    clearTimeout(timeoutId)
                    const owner = String(request.deviceAuth?.accountUuid || request.headers['x-sync-user'] || '')
                    releaseMeta = await acquireMetaUpstream(owner, AbortSignal.any([controller.signal, AbortSignal.timeout(META_QUEUE_WAIT_MS)]))
                    if (!releaseMeta) {
                        if (controller.signal.aborted) {
                            reply.status(499)
                            return { error: 'Stremio metadata request cancelled' }
                        }
                        reply.header('Retry-After', '2')
                        reply.status(503)
                        return { error: 'Stremio metadata queue is busy, try again shortly' }
                    }
                    metaTimeoutId = setTimeout(() => controller.abort(), 30000)
                }
                let response
                try {
                    response = await fetch('https://api.strem.io/api/' + apiPath, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(upstreamPayload),
                        signal: controller.signal
                    })
                } finally {
                    releaseMeta?.()
                    clearTimeout(metaTimeoutId)
                }
                if (type === 'AddonCollectionSet' && traceEnabled()) {
                    let respHead = ''
                    try { respHead = (await response.clone().text()).slice(0, 120) } catch {}
                    fastify.log.warn({ category: 'DebugTrace' }, `[DebugTrace] Set response: status=${response.status} body=${respHead}`)
                }

                clearTimeout(timeoutId)

                if (!response.ok && response.status >= 500 && attempt < MAX_RETRIES && !clientGone && withinClientBudget(attempt + 1)) {
                    await response.body?.cancel().catch(() => {})
                    continue
                }

                if (!response.ok && ['DatastoreGet', 'DatastorePut', 'DatastoreMeta', 'GetUser'].includes(type)) {
                    const retryAfter = response.headers.get('retry-after')
                    if (retryAfter) reply.header('Retry-After', retryAfter)
                    reply.status(response.status)
                    await response.body?.cancel().catch(() => {})
                    return { error: 'Stremio request failed' }
                }

                let data
                try {
                    const responseText = await response.text()
                    data = responseText ? JSON.parse(responseText) : {}
                } catch (parseError) {
                    if (type === 'AddonCollectionGet' && response.status === 403) {
                        if (canFallBackToStored(attempt)) {
                            storedFallback = true
                            skipBackoff = true
                            continue
                        }
                        const recovered = returnLastGoodCollection(payload.authKey, `HTTP ${response.status} refresh response`, ringAcct)
                        if (recovered) return recovered
                    }
                    throw parseError
                }

                if (type === 'AddonCollectionGet' && response.status === 403) {
                    if (canFallBackToStored(attempt)) {
                        trace('proxy.get', 'stored-fallback', { key: keyTag(payload.authKey), reason: 'http-403' })
                        storedFallback = true
                        skipBackoff = true
                        continue
                    }
                    const recovered = returnLastGoodCollection(payload.authKey, `HTTP ${response.status} refresh response`, ringAcct)
                    if (recovered) return recovered
                    if (!data?.error) {
                        data.error = `Upstream returned ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
                    }
                }

                if (type === 'DatastorePut' && payload.collection === 'libraryItem') {
                    const sample = payload.changes?.[0]
                    // Ring keeps only counts and the result flag; sampleId/sampleMtime (watch history) stay stdout-only.
                    fastify.log.info({ category: 'Sync', fmt: 'sync.library_put', n: payload.changes?.length, acct: ringAcct, result: data?.error ? 'error' : 'ok', removed: Array.isArray(payload.changes) ? payload.changes.filter(c => c?.removed).length : 0 }, `[Proxy] DatastorePut response: result=${JSON.stringify(data?.result)}, error=${JSON.stringify(data?.error)}, itemCount=${payload.changes?.length}, sampleId=${sample?._id}, sampleMtime=${sample?._mtime}, sampleRemoved=${sample?.removed}`)
                }

                if (type === 'AddonCollectionGet') {
                    const addons = data?.result?.addons
                    if (Array.isArray(addons)) {
                        const sanitizedAddons = dedupeAddonCollectionByTransportUrl(addons.map(sanitizeAddonForStremio))
                        const lastGood = getLastGoodCollection(payload.authKey)
                        if (isSuspiciousShrink(lastGood?.length || 0, sanitizedAddons.length)) {
                            if (attempt < MAX_RETRIES) {
                                fastify.log.warn({ category: 'Sync', fmt: 'sync.shrink_guard', acct: ringAcct, before: lastGood.length, after: sanitizedAddons.length, attempt: attempt + 1, max: MAX_RETRIES + 1 }, `[Proxy] Suspicious refresh shrink (${lastGood.length} -> ${sanitizedAddons.length}); re-reading to confirm before trusting it.`)
                                trace('proxy.get', 'shrink-retry', { lastGood: lastGood?.length || 0, got: sanitizedAddons.length, attempt })
                                continue
                            }
                            if (sanitizedAddons.length === 0) {
                                fastify.log.warn({ category: 'Sync', fmt: 'sync.shrink_guard', acct: ringAcct, before: lastGood.length, after: 0, attempt: MAX_RETRIES + 1, max: MAX_RETRIES + 1 }, `[Proxy] Persistent empty refresh after ${MAX_RETRIES} retries; keeping last-good (likely transient/auth glitch, not a real wipe): ${lastGood.length} -> 0`)
                                trace('proxy.get', 'served-last-good-empty', { lastGood: lastGood?.length || 0 })
                                return { result: { addons: lastGood, lastModified: Date.now() }, recoveredFromLastGood: true }
                            }
                            fastify.log.warn({ category: 'Sync' }, `[Proxy] Shrink confirmed after ${MAX_RETRIES} retries (${lastGood.length} -> ${sanitizedAddons.length}); accepting real collection and refreshing last-good.`)
                            trace('proxy.get', 'shrink-confirmed', { lastGood: lastGood?.length || 0, accepted: sanitizedAddons.length })
                        }
                        const validationError = validateAddonCollection(sanitizedAddons)
                        if (validationError && lastGood) {
                            fastify.log.warn({ category: 'Sync', fmt: 'sync.last_good', acct: ringAcct, reason: 'invalid-refresh' }, `[Proxy] Returning last-good addon collection after invalid refresh result: ${validationError}`)
                            return { result: { addons: lastGood, lastModified: Date.now() }, recoveredFromLastGood: true }
                        }
                        data.result.addons = sanitizedAddons
                        trace('proxy.get', 'fresh', { key: keyTag(payload.authKey), context: String(accountContext), lastGood: lastGood?.length || 0, returned: sanitizedAddons.length, addons: traceEnabled() ? briefAddons(sanitizedAddons) : undefined })
                        rememberGoodCollection(payload.authKey, data.result.addons, { allowEmpty: true })
                    } else if (data?.error) {
                        const errorText = typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
                        if (ADDON_REFRESH_ERROR_PATTERN.test(errorText)) {
                            if (canFallBackToStored(attempt)) {
                                trace('proxy.get', 'stored-fallback', { key: keyTag(payload.authKey), reason: 'refresh-error' })
                                storedFallback = true
                                skipBackoff = true
                                continue
                            }
                            const recovered = returnLastGoodCollection(payload.authKey, `Stremio refresh error: ${errorText}`, ringAcct)
                            if (recovered) return recovered
                        }
                    }
                }

                if (type === 'AddonCollectionSet' && !data?.error && Array.isArray(payload.addons) && (payload.addons.length > 0 || allowCollectionShrink)) {
                    rememberGoodCollection(payload.authKey, payload.addons, { allowEmpty: allowCollectionShrink })
                }
                if (type === 'AddonCollectionSet') bustHydraCache()

                if (type === 'DatastoreGet') {
                    const lib = Array.isArray(data?.result) ? data.result : (data?.result?.library && Array.isArray(data.result.library) ? data.result.library : null)
                    if (lib) {
                        const sanitize = items => items.map(item => {
                            if (item && item.removed) {
                                return { ...item, _ctime: item._ctime || '0001-01-01T00:00:00Z', _mtime: item._mtime || '0001-01-01T00:00:00Z' }
                            }
                            return item
                        })
                        if (Array.isArray(data.result)) {
                            data.result = sanitize(data.result)
                        } else {
                            data.result.library = sanitize(data.result.library)
                        }
                    }
                }

                if (type === 'AddonCollectionSet') {
                    trace('proxy.set', 'response', { context: String(accountContext), httpStatus: response.status, pushed: payload.addons?.length || 0 })
                }

                return data
            } catch (err) {
                clearTimeout(timeoutId)
                lastError = err
                const isTimeout = err.name === 'AbortError'
                const isRetryable = isTimeout || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err.code)

                if (isRetryable && attempt < MAX_RETRIES && !clientGone && withinClientBudget(attempt + 1)) {
                    continue
                }
                break
            } finally {
                if (activeController === controller) activeController = null
                request.raw.removeListener('aborted', onRequestAborted)
            }
        }
        } finally {
            request.raw.removeListener('aborted', onClientGone)
            reply.raw.removeListener('close', onReplyClose)
        }

        if (type === 'AddonCollectionSet') bustHydraCache()
        if (storedFallback) {
            const recovered = returnLastGoodCollection(payload.authKey, 'stored collection read failure', ringAcct)
            if (recovered) return recovered
        }

        fastify.log.error({ category: 'Server' }, `Stremio Proxy Final Failure (${type}): ${lastError?.message ?? 'Unknown'}`)
        reply.status(500);
        return { error: 'Stremio API Proxy Failed', details: 'Internal error' }
    })

    // Batch library metadata reads; failed entries return null for per-account fallback.
    // The 12/minute batch limit bounds upstream fan-out separately from single requests.
    fastify.post('/api/stremio-meta-batch', {
        bodyLimit: 256 * 1024,
        config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object',
                required: ['requests'],
                properties: { requests: { type: 'array' } },
                additionalProperties: true
            }
        }
    }, async (request, reply) => {
        const authResult = await requireProxyAuth(request, reply)
        if (authResult) return authResult

        const accountContext = request.headers['x-account-context'] || 'Unknown'
        const masked = maskContext(accountContext)
        const requests = Array.isArray(request.body.requests) ? request.body.requests : []
        if (requests.length === 0) {
            reply.status(400)
            return { error: 'stremio-meta-batch requires a non-empty requests array' }
        }
        if (requests.length > DATASTORE_META_BATCH_MAX) {
            reply.status(400)
            return { error: `stremio-meta-batch accepts at most ${DATASTORE_META_BATCH_MAX} requests` }
        }

        fastify.log.info({ category: 'Sync' }, `[${masked}] Batch Checking Library Changes (${requests.length} accounts)...`)
        const batchStartedAt = Date.now()
        const results = new Array(requests.length).fill(null)
        let nullSlots = 0
        let validSlots = 0
        let abortedSlots = 0
        let nextIndex = 0
        const metaOwner = String(request.deviceAuth?.accountUuid || request.headers['x-sync-user'] || '')
        const requestAbort = new AbortController()
        const onRequestAborted = () => requestAbort.abort()
        if (request.raw.aborted) requestAbort.abort()
        else request.raw.once('aborted', onRequestAborted)
        const workers = Array.from({ length: Math.min(DATASTORE_META_BATCH_CONCURRENCY, requests.length) }, async () => {
            while (nextIndex < requests.length) {
                const i = nextIndex++
                const entry = requests[i]
                const authKey = entry && typeof entry === 'object' ? entry.authKey : entry
                if (typeof authKey !== 'string' || !authKey) continue
                const release = await acquireMetaUpstream(metaOwner, requestAbort.signal)
                if (!release) { nullSlots++; abortedSlots++; continue }
                const controller = new AbortController()
                const onRequestAbort = () => controller.abort()
                if (request.raw.aborted) controller.abort()
                else request.raw.once('aborted', onRequestAbort)
                const timeout = setTimeout(() => controller.abort(), DATASTORE_META_BATCH_ENTRY_TIMEOUT_MS)
                try {
                    const res = await fetch(`${STREMIO_API}/datastoreMeta`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: 'DatastoreMeta', authKey, collection: 'libraryItem' }),
                        signal: controller.signal
                    })
                    if (!res.ok) { nullSlots++; continue }
                    const data = await res.json()
                    if (isValidMetaRows(data?.result)) {
                        results[i] = data.result
                        validSlots++
                    } else {
                        nullSlots++
                    }
                } catch {
                    // Leave failed slots null so callers can fall back.
                    nullSlots++
                } finally {
                    // Abort unread response bodies before releasing the worker slot.
                    controller.abort()
                    clearTimeout(timeout)
                    request.raw.removeListener('aborted', onRequestAbort)
                    release()
                }
            }
        })
        try {
            await Promise.all(workers)
        } finally {
            request.raw.removeListener('aborted', onRequestAborted)
        }
        trace('proxy.meta-batch', 'complete', {
            accounts: requests.length,
            validSlots,
            nullSlots,
            abortedSlots,
            timing: Date.now() - batchStartedAt,
        })
        return { result: results }
    })

    fastify.post('/api/aiostreams-proxy/user', {
        bodyLimit: 1024 * 1024,
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object',
                required: ['baseUrl', 'uuid', 'password'],
                properties: {
                    baseUrl: { type: 'string' },
                    uuid: { type: 'string' },
                    password: { type: 'string' },
                    // Raw view = the stored child config, so edits do not bake
                    // inherited parent values into the child. Default stays the
                    // merged (effective) view used for display.
                    raw: { type: 'boolean' }
                }
            }
        }
    }, async (request, reply) => {
        const { baseUrl, uuid, password, raw } = request.body
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const url = raw === true
            ? `${baseUrl}/api/v1/user?raw=true`
            : `${baseUrl}/api/v1/user`
        if (!(await isSafeUrlResolved(url))) {
            reply.status(403); return { error: 'Access Denied: Unsafe URL' }
        }
        try {
            const { response, json } = await fetchAIOStreamsJson(url, {
                headers: {
                    'Accept': 'application/json',
                    'Authorization': getAIOStreamsAuthHeader(uuid, password),
                },
            })

            if (response.status >= 300 && response.status < 400) {
                reply.status(403); return { error: 'Access Denied: Redirect not allowed' }
            }
            reply.status(response.status)
            return json
        } catch (e) {
            fastify.log.error({ category: 'AIOStreamsProxy' }, `GET failed: ${e.message}`)
            reply.status(502); return { success: false, error: { message: 'Failed to reach AIOStreams instance' } }
        }
    })

    fastify.put('/api/aiostreams-proxy', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object',
                required: ['baseUrl', 'uuid', 'password', 'config'],
                properties: {
                    baseUrl: { type: 'string' },
                    uuid: { type: 'string' },
                    password: { type: 'string' },
                    config: { type: 'object', additionalProperties: true }
                }
            }
        }
    }, async (request, reply) => {
        const { baseUrl, uuid, password, config } = request.body
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const url = `${baseUrl}/api/v1/user`
        if (!(await isSafeUrlResolved(url))) {
            reply.status(403); return { error: 'Access Denied: Unsafe URL' }
        }
        try {
            const { response, json } = await fetchAIOStreamsJson(url, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': getAIOStreamsAuthHeader(uuid, password),
                },
                body: JSON.stringify({ config }),
            })

            if (response.status >= 300 && response.status < 400) {
                reply.status(403); return { error: 'Access Denied: Redirect not allowed' }
            }
            reply.status(response.status)
            return json
        } catch (e) {
            fastify.log.error({ category: 'AIOStreamsProxy' }, `PUT failed: ${e.message}`)
            reply.status(502); return { success: false, error: { message: 'Failed to reach AIOStreams instance' } }
        }
    })

    fastify.post('/api/aiostreams-proxy', {
        bodyLimit: 1024 * 1024,
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object',
                required: ['baseUrl', 'password', 'config'],
                properties: {
                    baseUrl: { type: 'string' },
                    password: { type: 'string' },
                    config: { type: 'object', additionalProperties: true }
                }
            }
        }
    }, async (request, reply) => {
        const { baseUrl, password, config } = request.body
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const url = `${baseUrl}/api/v1/user`
        if (!(await isSafeUrlResolved(url))) {
            reply.status(403); return { error: 'Access Denied: Unsafe URL' }
        }
        try {
            const { response, json } = await fetchAIOStreamsJson(url, {
                method: 'POST',
                rateLimitRetries: 0,
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ password, config })
            })
            if (response.status >= 300 && response.status < 400) {
                reply.status(403); return { error: 'Access Denied: Redirect not allowed' }
            }
            reply.status(response.status)
            return json
        } catch (e) {
            fastify.log.error({ category: 'AIOStreamsProxy' }, `POST failed: ${e.message}`)
            reply.status(502); return { success: false, error: { message: 'Failed to reach AIOStreams instance' } }
        }
    })

    fastify.delete('/api/aiostreams-proxy', {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object',
                required: ['baseUrl', 'uuid', 'password'],
                properties: {
                    baseUrl: { type: 'string' },
                    uuid: { type: 'string' },
                    password: { type: 'string' }
                }
            }
        }
    }, async (request, reply) => {
        const { baseUrl, uuid, password } = request.body
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const url = `${baseUrl}/api/v1/user`
        if (!(await isSafeUrlResolved(url))) {
            reply.status(403); return { error: 'Access Denied: Unsafe URL' }
        }
        try {
            const { response, json } = await fetchAIOStreamsJson(url, {
                method: 'DELETE',
                headers: {
                    'Accept': 'application/json',
                    'Authorization': getAIOStreamsAuthHeader(uuid, password),
                },
            })

            if (response.status >= 300 && response.status < 400) {
                reply.status(403); return { error: 'Access Denied: Redirect not allowed' }
            }
            reply.status(response.status)
            return json
        } catch (e) {
            fastify.log.error({ category: 'AIOStreamsProxy' }, `DELETE failed: ${e.message}`)
            reply.status(502); return { success: false, error: { message: 'Failed to reach AIOStreams instance' } }
        }
    })

    fastify.get('/api/aiostreams-check', {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        schema: {
            querystring: {
                type: 'object',
                required: ['baseUrl', 'uuid'],
                properties: {
                    baseUrl: { type: 'string' },
                    uuid: { type: 'string' }
                }
            }
        }
    }, async (request, reply) => {
        const { baseUrl, uuid } = request.query
        const authUser = await verifyAuth(request)
        if (!authUser) {
            reply.status(401)
            return { success: false, error: { message: 'Authentication required' } }
        }
        const url = `${baseUrl}/api/v1/user?uuid=${encodeURIComponent(uuid)}`
        if (!(await isSafeUrlResolved(url))) {
            reply.status(403); return { success: false, error: { message: 'Unsafe URL' } }
        }
        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 10000)
            const MAX_REDIRECTS = 3
            let currentUrl = url
            let response
            for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
                response = await guardedWebFetch(currentUrl, { method: 'HEAD', signal: controller.signal, redirect: 'manual' })
                if (response.status >= 300 && response.status < 400) {
                    const location = response.headers.get('location')
                    if (!location) {
                        clearTimeout(timeout)
                        reply.status(403); return { success: false, error: { message: 'Unsafe redirect' } }
                    }
                    const resolvedUrl = new URL(location, currentUrl).href
                    if (!isSafeUrl(resolvedUrl)) {
                        clearTimeout(timeout)
                        reply.status(403); return { success: false, error: { message: 'Unsafe redirect target' } }
                    }
                    currentUrl = resolvedUrl
                    continue
                }
                break
            }
            clearTimeout(timeout)
            reply.status(200)
            return { success: true, exists: response.ok }
        } catch (e) {
            if (e.code === 'ssrf-blocked') { reply.status(403); return { success: false, error: { message: 'Unsafe redirect target' } } }
            fastify.log.error({ category: 'AIOStreamsProxy' }, `Check failed: ${e.message}`)
            reply.status(502)
            return { success: false, error: { message: 'Failed to reach AIOStreams instance' } }
        }
    })

    fastify.get('/api/aiostreams-status', {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        schema: {
            querystring: {
                type: 'object',
                required: ['baseUrl'],
                properties: { baseUrl: { type: 'string' } }
            }
        }
    }, async (request, reply) => {
        const { baseUrl } = request.query
        const authUser = await verifyAuth(request)
        if (!authUser) {
            reply.status(401)
            return { error: { message: 'Authentication required' } }
        }
        const url = `${baseUrl}/api/v1/status`
        if (!(await isSafeUrlResolved(url))) {
            reply.status(403); return { success: false, error: { message: 'Unsafe URL' } }
        }
        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 10000)
            const MAX_REDIRECTS = 3
            let currentUrl = url
            let response
            for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
                response = await guardedWebFetch(currentUrl, { signal: controller.signal, redirect: 'manual' })
                if (response.status >= 300 && response.status < 400) {
                    const location = response.headers.get('location')
                    if (!location) {
                        clearTimeout(timeout)
                        reply.status(403); return { success: false, error: { message: 'Unsafe redirect' } }
                    }
                    const resolvedUrl = new URL(location, currentUrl).href
                    if (!isSafeUrl(resolvedUrl)) {
                        clearTimeout(timeout)
                        reply.status(403); return { success: false, error: { message: 'Unsafe redirect target' } }
                    }
                    currentUrl = resolvedUrl
                    continue
                }
                break
            }
            clearTimeout(timeout)
            if (!response.ok) { reply.status(502); return { success: false, error: { message: 'Instance returned an error' } } }
            const data = await response.json()
            return { success: true, data: data.data || data }
        } catch (e) {
            return { success: false, error: { message: e.message } }
        }
    })

    const aiometadataConfigUrl = (baseUrl, path) => `${baseUrl.replace(/\/+$/, '')}/api/config${path}`

    fastify.post('/api/aiometadata-proxy/load', {
        bodyLimit: 1024 * 1024,
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object',
                required: ['baseUrl', 'uuid', 'password'],
                properties: {
                    baseUrl: { type: 'string' },
                    uuid: { type: 'string' },
                    password: { type: 'string' },
                    addonPassword: { type: 'string' }
                }
            }
        }
    }, async (request, reply) => {
        const { baseUrl, uuid, password, addonPassword } = request.body
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const url = aiometadataConfigUrl(baseUrl, `/load/${encodeURIComponent(uuid)}`)
        if (!(await isSafeUrlResolved(url))) {
            reply.status(403); return { error: 'Access Denied: Unsafe URL' }
        }
        try {
            const { response, json } = await fetchAIOStreamsJson(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ password, addonPassword }),
            })
            if (response.status >= 300 && response.status < 400) {
                reply.status(403); return { error: 'Access Denied: Redirect not allowed' }
            }
            reply.status(response.status)
            return json
        } catch (e) {
            fastify.log.error({ category: 'AIOMetadataProxy' }, `LOAD failed: ${e.message}`)
            reply.status(502); return { success: false, error: { message: 'Failed to reach AIOMetadata instance' } }
        }
    })

    fastify.post('/api/aiometadata-proxy/save', {
        bodyLimit: 1024 * 1024,
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object',
                required: ['baseUrl', 'password', 'config'],
                properties: {
                    baseUrl: { type: 'string' },
                    password: { type: 'string' },
                    config: { type: 'object', additionalProperties: true },
                    addonPassword: { type: 'string' }
                }
            }
        }
    }, async (request, reply) => {
        const { baseUrl, password, config, addonPassword } = request.body
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const url = aiometadataConfigUrl(baseUrl, '/save')
        if (!(await isSafeUrlResolved(url))) {
            reply.status(403); return { error: 'Access Denied: Unsafe URL' }
        }
        try {
            const { response, json } = await fetchAIOStreamsJson(url, {
                method: 'POST',
                rateLimitRetries: 0,
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ config, password, addonPassword }),
            })
            if (response.status >= 300 && response.status < 400) {
                reply.status(403); return { error: 'Access Denied: Redirect not allowed' }
            }
            reply.status(response.status)
            return json
        } catch (e) {
            fastify.log.error({ category: 'AIOMetadataProxy' }, `SAVE failed: ${e.message}`)
            reply.status(502); return { success: false, error: { message: 'Failed to reach AIOMetadata instance' } }
        }
    })

    fastify.post('/api/aiometadata-proxy/update', {
        bodyLimit: 1024 * 1024,
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object',
                required: ['baseUrl', 'uuid', 'password', 'config'],
                properties: {
                    baseUrl: { type: 'string' },
                    uuid: { type: 'string' },
                    password: { type: 'string' },
                    config: { type: 'object', additionalProperties: true },
                    addonPassword: { type: 'string' },
                    // Loaded-config version: the instance replies 409
                    // CONFIG_CHANGED when its stored config is newer. The 409
                    // body passes through untouched so the client can surface
                    // a typed conflict. `force` is deliberately not accepted.
                    baseVersion: { type: 'number' }
                }
            }
        }
    }, async (request, reply) => {
        const { baseUrl, uuid, password, config, addonPassword, baseVersion } = request.body
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const url = aiometadataConfigUrl(baseUrl, `/update/${encodeURIComponent(uuid)}`)
        if (!(await isSafeUrlResolved(url))) {
            reply.status(403); return { error: 'Access Denied: Unsafe URL' }
        }
        const upstreamBody = { config, password, addonPassword }
        if (typeof baseVersion === 'number' && Number.isFinite(baseVersion)) {
            upstreamBody.baseVersion = baseVersion
        }
        try {
            const { response, json } = await fetchAIOStreamsJson(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify(upstreamBody),
            })
            if (response.status >= 300 && response.status < 400) {
                reply.status(403); return { error: 'Access Denied: Redirect not allowed' }
            }
            reply.status(response.status)
            return json
        } catch (e) {
            fastify.log.error({ category: 'AIOMetadataProxy' }, `UPDATE failed: ${e.message}`)
            reply.status(502); return { success: false, error: { message: 'Failed to reach AIOMetadata instance' } }
        }
    })

    fastify.get('/api/aiometadata-status', {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        schema: {
            querystring: {
                type: 'object',
                required: ['baseUrl'],
                properties: { baseUrl: { type: 'string' } }
            }
        }
    }, async (request, reply) => {
        const { baseUrl } = request.query
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: { message: 'Authentication required' } } }

        const url = aiometadataConfigUrl(baseUrl, '/addon-info')
        if (!(await isSafeUrlResolved(url))) {
            reply.status(403); return { success: false, error: { message: 'Unsafe URL' } }
        }
        try {
            const { response, json } = await fetchAIOStreamsJson(url, { headers: { 'Accept': 'application/json' } })
            if (response.status >= 300 && response.status < 400) {
                reply.status(403); return { success: false, error: { message: 'Unsafe redirect' } }
            }
            if (!response.ok) { reply.status(response.status); return { success: false, error: { message: 'Instance returned an error' } } }
            return { success: true, data: json }
        } catch (e) {
            fastify.log.error({ category: 'AIOMetadataProxy' }, `Status failed: ${e.message}`)
            reply.status(502); return { success: false, error: { message: 'Failed to reach AIOMetadata instance' } }
        }
    })

    fastify.get('/api/aiometadata-check', {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        schema: {
            querystring: {
                type: 'object',
                required: ['baseUrl', 'uuid'],
                properties: { baseUrl: { type: 'string' }, uuid: { type: 'string' } }
            }
        }
    }, async (request, reply) => {
        const { baseUrl, uuid } = request.query
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { success: false, error: { message: 'Authentication required' } } }

        const url = aiometadataConfigUrl(baseUrl, `/trusted/${encodeURIComponent(uuid)}`)
        if (!(await isSafeUrlResolved(url))) {
            reply.status(403); return { success: false, error: { message: 'Unsafe URL' } }
        }
        try {
            const { response, json } = await fetchAIOStreamsJson(url, { headers: { 'Accept': 'application/json' } })
            if (response.status >= 300 && response.status < 400) {
                reply.status(403); return { success: false, error: { message: 'Unsafe redirect' } }
            }
            reply.status(response.status)
            return { success: response.ok, data: json }
        } catch (e) {
            fastify.log.error({ category: 'AIOMetadataProxy' }, `Check failed: ${e.message}`)
            reply.status(502); return { success: false, error: { message: 'Failed to reach AIOMetadata instance' } }
        }
    })

    function proxyHmac(payload) {
        return Promise.resolve(createHmac('sha256', PRIMARY_KEY).update(payload).digest('hex'))
    }

    fastify.post('/api/proxy/mint-token', {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        const { url, name, logo } = request.body || {}
        if (!url || typeof url !== 'string') { reply.status(400); return { error: 'Missing url' } }
        if (!(await isSafeUrlResolved(url))) { reply.status(403); return { error: 'Unsafe URL' } }
        const PROXY_TOKEN_TTL = 90 * 24 * 60 * 60 * 1000
        const payload = JSON.stringify({ url, name: name || '', logo: logo || '', exp: Date.now() + PROXY_TOKEN_TTL })
        const encoded = Buffer.from(payload, 'utf-8').toString('base64url')
        const sig = await proxyHmac(encoded)
        return { token: `${encoded}.${sig}` }
    })

    fastify.all('/api/proxy/:token/*', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { token } = request.params
        const pathSuffix = request.params['*']

        const dotIdx = token.lastIndexOf('.')
        if (dotIdx < 1) {
            reply.status(403); return { error: 'Invalid Token' }
        }
        const encoded = token.slice(0, dotIdx)
        const sig = token.slice(dotIdx + 1)
        const expectedSig = await proxyHmac(encoded)
        const sigBuf = Buffer.from(sig)
        const expBuf = Buffer.from(expectedSig)
        if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
            reply.status(403); return { error: 'Invalid Token Signature' }
        }

        let targetDomain = 'unknown'
        let originalUrl = ''
        let tokenExp = 0
        try {
            const config = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'))
            targetDomain = new URL(config.url).origin
            originalUrl = config.url
            tokenExp = typeof config.exp === 'number' ? config.exp : 0
        } catch (e) {
            fastify.log.warn({ category: 'Proxy' }, `Failed to decode token: ${e.message}`)
            reply.status(400);
            return { error: 'Invalid Token' }
        }

        if (tokenExp > 0 && Date.now() > tokenExp) {
            reply.status(403);
            return { error: 'Token Expired' }
        }

        if (!isSafeUrl(originalUrl)) {
            fastify.log.warn({ category: 'Security' }, `blocked unsafe proxy request (Manifest Rewriter): ${truncateUrl(originalUrl)}`)
            reply.status(403);
            return { error: 'Access Denied: Unsafe URL' }
        }

        return enqueueProxyRequest(targetDomain, async () => {
            let customName = null, customLogo = null
            try {
                const configStr = Buffer.from(encoded, 'base64url').toString('utf-8')
                const config = JSON.parse(configStr)
                const { url: originalUrl, name, logo } = config
                customName = name || null
                customLogo = logo || null

                if (!originalUrl) {
                    reply.status(400);
                    return { error: 'Invalid proxy configuration' }
                }

                let targetUrl
                if (pathSuffix && pathSuffix !== 'manifest.json' && pathSuffix !== '') {
                    if (pathSuffix.includes('..') || !/^[a-zA-Z0-9\-_./:@]+$/.test(pathSuffix)) {
                        reply.status(400);
                        return { error: 'Invalid path' }
                    }
                }
                if (pathSuffix === 'manifest.json' || pathSuffix === '') {
                    targetUrl = originalUrl
                } else {
                    const baseUrl = originalUrl.replace(/\/manifest\.json$/, '').replace(/\/$/, '')
                    targetUrl = `${baseUrl}/${pathSuffix}`
                }

                const fetchController = new AbortController()
                const fetchTimeout = setTimeout(() => fetchController.abort(), 10000)
                let response
                try {
                    response = await guardedWebFetch(targetUrl, {
                        method: request.method,
                        redirect: 'manual',
                        maxBytes: 5 * 1024 * 1024,
                        signal: fetchController.signal,
                        headers: {
                            'User-Agent': 'AIOManager-ManifestRewriter/1.0'
                        }
                    })
                } finally {
                    clearTimeout(fetchTimeout)
                }

                if (!response.ok) {
                    reply.status(response.status);
                    return response.statusText
                }

                if ((pathSuffix === 'manifest.json' || pathSuffix === '') && (customName || customLogo)) {
                    const manifest = await response.json()
                    if (customName) manifest.name = customName
                    if (customLogo) manifest.logo = customLogo
                    manifest.description = (manifest.description || '') + '\n[Proxied by AIOManager]'
                    return manifest
                }

                const contentType = response.headers.get('content-type')
                if (contentType) reply.type(contentType)
                // FIX: Fastify/Compress doesn't handle Web ReadableStream well, convert to Buffer
                const arrayBuffer = await response.arrayBuffer()
                const buffer = Buffer.from(arrayBuffer)
                if (buffer.length > 5 * 1024 * 1024) {
                    reply.status(413);
                    return { error: 'Payload Too Large (>5MB)' }
                }
                return buffer

            } catch (err) {
                if (err.code === 'ssrf-blocked') {
                    reply.status(403)
                    return { error: 'Access Denied: Unsafe URL' }
                }
                if (err.code === 'too-large') {
                    reply.status(413)
                    return { error: 'Payload Too Large (>5MB)' }
                }
                // PROXY RESILIENCE: If upstream is dead (offline), we MUST return a valid manifest
                // so Stremio doesn't delete the addon or show garbage.
                if ((pathSuffix === 'manifest.json' || pathSuffix === '') && customName) {
                    fastify.log.warn({ category: 'Proxy' }, `Upstream offline: ${targetDomain}. Serving fallback manifest for ${customName}.`)
                    return {
                        id: 'proxy-offline-' + Date.now(),
                        name: customName,
                        version: '0.0.1',
                        description: 'This addon is currently offline or unreachable. The Manager is attempting to restore connection.',
                        logo: customLogo,
                        resources: [],
                        types: [],
                        catalogs: []
                    }
                }

                fastify.log.error({ category: 'Proxy' }, `Fatal Error: ${err.message}`)
                reply.status(502);
                return { error: 'Proxy Error', details: 'Upstream Unreachable' }
            }
        })
    })

    fastify.get('/api/addon-health', {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Authentication required' } }

        const { url } = request.query

        if (!url) {
            reply.status(400);
            return { isOnline: false, error: 'Bad Request: Missing URL' }
        }

        if (!(await isSafeUrlResolved(url))) {
            reply.status(400);
            return { isOnline: false, error: 'Bad Request: Unsafe URL' }
        }

        try {
            const isOnline = await checkAddonHealthInternal(url, 'Addon Health')
            return { isOnline, error: isOnline ? undefined : 'Unreachable' }
        } catch (err) {
            fastify.log.error({ category: 'HealthProxy' }, `Failed to check health for ${url}: ${err.message}`)
            reply.status(500);
            return { isOnline: false, error: 'Internal Server Error' }
        }
    })

    fastify.get('/api/discover-proxy', {
        config: { rateLimit: { max: 600, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authResult = await requireProxyAuth(request, reply)
        if (authResult) return authResult

        const targetUrl = request.query.url
        if (!targetUrl || !targetUrl.startsWith('https://stremio-addons.net/api/v0/')) {
            return reply.code(400).send({ error: 'Invalid URL' })
        }

        const start = Date.now()
        const cacheKey = `discover:${targetUrl}`
        const cached = manifestCache.get(cacheKey)
        const isCategory = targetUrl.includes('/categories')
        const ttl = isCategory ? 60 * 60 * 1000 : 30 * 60 * 1000
        const cacheHit = Boolean(cached && Date.now() - cached.ts < ttl)
        trace('discover-proxy', 'request', { url: targetUrl, cacheHit })

        if (cacheHit) {
            reply.header('X-Cache', 'HIT')
            reply.header('Cache-TTL-Ms', ttl - (Date.now() - cached.ts))
            reply.header('Cache-Control', 'public, max-age=600')
            trace('discover-proxy', 'response', { url: targetUrl, cacheHit: true, timing: Date.now() - start })
            return reply.send(cached.data)
        }

        const negative = manifestNegativeGet(cacheKey)
        if (negative) {
            if (cached) {
                reply.header('X-Cache', 'STALE')
                return reply.send(cached.data)
            }
            reply.header('X-Cache', 'NEGATIVE')
            return reply.code(negative.status).send(negative.data)
        }

        try {
            let pending = discoverInflight.get(cacheKey)
            if (!pending) {
                pending = enqueueProxyRequest(targetUrl, async () => {
                    const controller = new AbortController()
                    const timeout = setTimeout(() => controller.abort(), 15000)
                    try {
                        const res = await fetch(targetUrl, {
                            signal: controller.signal,
                            headers: { 'Accept': 'application/json' }
                        })
                        if (!res.ok) return { status: res.status, data: { error: `Upstream returned ${res.status}` } }
                        return { status: 200, data: await res.json() }
                    } finally {
                        clearTimeout(timeout)
                    }
                }).finally(() => discoverInflight.delete(cacheKey))
                discoverInflight.set(cacheKey, pending)
            }
            const { status, data } = await pending
            if (status !== 200) reply.code(status)

            if (data.error) {
                manifestNegativeSet(cacheKey, { status, data })
                reply.header('X-Cache', 'MISS')
                trace('discover-proxy', 'response', { url: targetUrl, cacheHit: false, error: true, timing: Date.now() - start })
                return reply.send(data)
            } else {
                manifestCache.set(cacheKey, { data, ts: Date.now() })
                if (manifestCache.size > 5000) {
                    const now = Date.now()
                    for (const [k, v] of manifestCache) {
                        if (now - v.ts > MANIFEST_CACHE_TTL) manifestCache.delete(k)
                    }
                    while (manifestCache.size > 4000) {
                        const oldestKey = manifestCache.keys().next().value
                        if (oldestKey === undefined) break
                        manifestCache.delete(oldestKey)
                    }
                }
                reply.header('X-Cache', 'MISS')
                reply.header('Cache-Control', 'public, max-age=600')
                trace('discover-proxy', 'response', { url: targetUrl, cacheHit: false, timing: Date.now() - start })
                return reply.send(data)
            }
        } catch (err) {
            manifestNegativeSet(cacheKey, { status: 502, data: { error: 'Failed to fetch from stremio-addons.net' } })
            const cachedStale = manifestCache.get(cacheKey)
            if (cachedStale) {
                reply.header('X-Cache', 'STALE')
                trace('discover-proxy', 'response', { url: targetUrl, cacheHit: false, stale: true, timing: Date.now() - start })
                return reply.send(cachedStale.data)
            }
            trace('discover-proxy', 'response', { url: targetUrl, cacheHit: false, error: true, timing: Date.now() - start })
            return reply.code(502).send({ error: 'Failed to fetch from stremio-addons.net' })
        }
    })
}
