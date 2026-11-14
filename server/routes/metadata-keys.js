import db from '../db.js'
import { kvHeadSource } from '../lib/kv-head.js'
import { encrypt, decrypt } from '../crypto.js'
import { PRIMARY_KEY, FALLBACK_KEYS } from '../keys.js'
import { verifyAuth, timingSafeEqual, authenticateDeviceCredential } from '../auth.js'
import { getCachedAuthBound, hashAuthPassword } from '../state.js'
import { assertWritablePrimary } from '../admin/account-state.js'
import { isSafeUrl } from '../utils/ssrf.js'
import { guardedWebFetch } from '../utils/safe-fetch.js'
import { maskContext } from '../utils/log-helpers.js'
import { invalidateUserKey } from '../lib/user-key-cache.js'

const SUPPORTED_PROVIDERS = new Set([
    'tmdb', 'tvdb', 'mdblist', 'simkl', 'pmdb'
])

const KeyFormat = { type: 'string', enum: ['v3', 'v4', 'unknown'] }

const ErrorResponse = {
    type: 'object',
    required: ['error'],
    properties: { error: { type: 'string' } }
}

const ProviderParam = {
    type: 'object',
    properties: { provider: { type: 'string' } }
}

const PROVIDER_KEY_ALIASES = {
    themoviedb: 'tmdb',
    'the-moviedb': 'tmdb',
    themoviedb_org: 'tmdb',
    'tvdb.com': 'tvdb',
    thetvdb: 'tvdb',
    'publicmetadb': 'pmdb',
    'publicmetadb.com': 'pmdb',
    publicmeta: 'pmdb',
    'fanart.tv': 'fanart',
    'mdblist.com': 'mdblist',
}

function normalizeProvider(raw) {
    if (typeof raw !== 'string') return null
    const lower = raw.trim().toLowerCase()
    if (!lower) return null
    const aliased = PROVIDER_KEY_ALIASES[lower] || lower
    if (!SUPPORTED_PROVIDERS.has(aliased)) return null
    return aliased
}

function detectKeyFormat(key) {
    if (typeof key !== 'string' || !key) return 'unknown'
    if (/^[0-9a-fA-F]{32}$/.test(key)) return 'v3'
    if (key.startsWith('eyJ')) return 'v4'
    return 'unknown'
}

function isValidKeyValue(key) {
    return typeof key === 'string' && key.trim().length > 0 && key.length <= 4096
}

async function upsertMetadataKey(tx, userId, provider, encryptedKey, keyFormat, now) {
    await tx.run(
        `INSERT INTO metadata_keys (user_id, provider, encrypted_key, key_format, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, provider) DO UPDATE SET
            encrypted_key = excluded.encrypted_key,
            key_format = excluded.key_format,
            updated_at = excluded.updated_at`,
        [userId, provider, encryptedKey, keyFormat, now, now]
    )
}

async function workspaceBinding(userId) {
    const row = await db.get(`SELECT password FROM ${kvHeadSource()} WHERE key = $1`, [userId])
    return row ? String(row.password ?? '') : null
}

async function withWorkspaceBinding(userId, binding, write) {
    return db.tx(async tx => {
        const lock = db.type === 'postgres' ? ' FOR UPDATE' : ''
        const row = await tx.get(`SELECT password FROM kv_store WHERE key = $1${lock}`, [userId])
        if (!row || String(row.password ?? '') !== binding) return false
        await write(tx)
        return true
    }, { immediate: true })
}

export function registerMetadataKeysRoutes(fastify) {
    fastify.post('/api/metadata-keys', {
        bodyLimit: 1024 * 16,
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
        schema: {
            tags: ['metadata-keys'],
            summary: 'Store or update a provider API key',
            body: {
                type: 'object',
                required: ['provider', 'key'],
                properties: {
                    provider: { type: 'string', description: 'Provider id or known alias (tmdb, tvdb, mdblist, simkl, pmdb)' },
                    key: { type: 'string', description: 'API key value' }
                }
            },
            response: {
                200: {
                    type: 'object',
                    required: ['success', 'provider', 'keyFormat'],
                    properties: {
                        success: { type: 'boolean' },
                        provider: { type: 'string', description: 'Normalized provider id' },
                        keyFormat: KeyFormat
                    }
                },
                400: ErrorResponse,
                401: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        const binding = authUser ? await workspaceBinding(authUser) : null
        const boundAuth = request.deviceAuth
            ? (await authenticateDeviceCredential(authUser, request.headers['x-sync-device'], request.headers['x-sync-password'])).ok
            : timingSafeEqual(getCachedAuthBound('sync:' + authUser, binding), hashAuthPassword(request.headers['x-sync-password']))
        if (!authUser || binding === null || !boundAuth) {
            reply.status(401); return { error: 'Unauthorized' }
        }
        assertWritablePrimary()

        const { provider: rawProvider, key: rawKey } = request.body || {}
        const provider = normalizeProvider(rawProvider)
        if (!provider) {
            reply.status(400); return { error: 'Unsupported provider' }
        }
        if (!isValidKeyValue(rawKey)) {
            reply.status(400); return { error: 'Invalid key' }
        }

        const key = rawKey.trim()
        const keyFormat = detectKeyFormat(key)
        const now = Date.now()

        try {
            const saved = await withWorkspaceBinding(authUser, binding, tx => upsertMetadataKey(tx, authUser, provider, encrypt(key, PRIMARY_KEY), keyFormat, now))
            if (!saved) { reply.status(401); return { error: 'Unauthorized' } }
            invalidateUserKey(authUser, provider)
        } catch (err) {
            fastify.log.error({ category: 'MetadataKeys' }, `Save failed for provider ${provider}: ${err.message}`)
            reply.status(500); return { error: 'Failed to save key' }
        }

        fastify.log.info({ category: 'MetadataKeys' }, `Stored ${provider} (${keyFormat}) key for user ${maskContext(authUser)}.`)
        return { success: true, provider, keyFormat }
    })

    fastify.get('/api/metadata-keys', {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        schema: {
            tags: ['metadata-keys'],
            summary: 'List configured providers without exposing raw keys',
            response: {
                200: {
                    type: 'object',
                    required: ['providers'],
                    properties: {
                        providers: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['provider', 'keyFormat', 'updatedAt'],
                                properties: {
                                    provider: { type: 'string' },
                                    keyFormat: KeyFormat,
                                    updatedAt: { type: 'number', description: 'Unix epoch (ms) of last update' }
                                }
                            }
                        }
                    }
                },
                401: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        try {
            const rows = await db.query(
                'SELECT provider, key_format, updated_at FROM metadata_keys WHERE user_id = $1 ORDER BY provider ASC',
                [authUser]
            )
            const providers = (rows || []).map(row => ({
                provider: row.provider,
                keyFormat: row.key_format || 'unknown',
                updatedAt: Number(row.updated_at) || 0
            }))
            return { providers }
        } catch (err) {
            fastify.log.error({ category: 'MetadataKeys' }, `List failed: ${err.message}`)
            reply.status(500); return { error: 'Failed to list keys' }
        }
    })

    fastify.delete('/api/metadata-keys/:provider', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
        schema: {
            tags: ['metadata-keys'],
            summary: 'Delete a stored provider key',
            params: ProviderParam,
            response: {
                200: {
                    type: 'object',
                    required: ['success'],
                    properties: { success: { type: 'boolean' } }
                },
                400: ErrorResponse,
                401: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()

        const rawProvider = request.params.provider
        if (typeof rawProvider !== 'string' || !/^[a-z0-9_-]+$/i.test(rawProvider)) {
            reply.status(400); return { error: 'Invalid provider' }
        }
        const provider = normalizeProvider(rawProvider) || rawProvider.toLowerCase()

        try {
            await db.run(
                'DELETE FROM metadata_keys WHERE user_id = $1 AND provider = $2',
                [authUser, provider]
            )
            invalidateUserKey(authUser, provider)
        } catch (err) {
            fastify.log.error({ category: 'MetadataKeys' }, `Delete failed for provider ${provider}: ${err.message}`)
            reply.status(500); return { error: 'Failed to delete key' }
        }

        return { success: true }
    })

    fastify.get('/api/metadata-keys/:provider/value', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
        schema: {
            tags: ['metadata-keys'],
            summary: 'Decrypt and return the raw provider key',
            params: ProviderParam,
            response: {
                200: {
                    type: 'object',
                    required: ['provider', 'key'],
                    properties: {
                        provider: { type: 'string' },
                        key: { type: 'string' }
                    }
                },
                400: ErrorResponse,
                401: ErrorResponse,
                404: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser || !await db.get('SELECT 1 FROM kv_store WHERE key = $1', [authUser])) { reply.status(401); return { error: 'Unauthorized' } }

        const provider = normalizeProvider(request.params.provider)
        if (!provider) {
            reply.status(400); return { error: 'Unsupported provider' }
        }

        try {
            const row = await db.get(
                'SELECT encrypted_key FROM metadata_keys WHERE user_id = $1 AND provider = $2',
                [authUser, provider]
            )
            if (!row?.encrypted_key) {
                reply.status(404); return { error: 'Key not found' }
            }
            const plaintext = decrypt(row.encrypted_key, FALLBACK_KEYS)
            if (!plaintext) {
                reply.status(500); return { error: 'Failed to decrypt key' }
            }
            return { provider, key: plaintext }
        } catch (err) {
            fastify.log.error({ category: 'MetadataKeys' }, `Get value failed for provider ${provider}: ${err.message}`)
            reply.status(500); return { error: 'Failed to get key' }
        }
    })

    fastify.post('/api/metadata-keys/import-aiometadata', {
        bodyLimit: 1024 * 16,
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
        schema: {
            tags: ['metadata-keys'],
            summary: 'Import provider keys from an AIOMetadata instance',
            body: {
                type: 'object',
                required: ['aiometadataUrl', 'uuid', 'password'],
                properties: {
                    aiometadataUrl: { type: 'string' },
                    uuid: { type: 'string' },
                    password: { type: 'string' },
                    addonPassword: { type: 'string' }
                }
            },
            response: {
                200: {
                    type: 'object',
                    required: ['imported'],
                    properties: {
                        imported: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['provider', 'keyFormat'],
                                properties: {
                                    provider: { type: 'string' },
                                    keyFormat: KeyFormat
                                }
                            }
                        }
                    }
                },
                400: ErrorResponse,
                401: ErrorResponse,
                502: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        const binding = authUser ? await workspaceBinding(authUser) : null
        const boundAuth = request.deviceAuth
            ? (await authenticateDeviceCredential(authUser, request.headers['x-sync-device'], request.headers['x-sync-password'])).ok
            : timingSafeEqual(getCachedAuthBound('sync:' + authUser, binding), hashAuthPassword(request.headers['x-sync-password']))
        if (!authUser || binding === null || !boundAuth) {
            reply.status(401); return { error: 'Unauthorized' }
        }
        assertWritablePrimary()

        const { aiometadataUrl: rawUrl, uuid: rawUuid, password, addonPassword } = request.body || {}
        const baseUrl = typeof rawUrl === 'string' ? rawUrl.trim().replace(/\/+$/, '') : ''
        const uuid = typeof rawUuid === 'string' ? rawUuid.trim() : ''
        if (!baseUrl || !uuid || typeof password !== 'string' || password.length === 0) {
            reply.status(400); return { error: 'aiometadataUrl, uuid and password are required' }
        }

        const targetUrl = `${baseUrl}/api/config/load/${encodeURIComponent(uuid)}`
        if (!isSafeUrl(targetUrl)) {
            reply.status(400); return { error: 'Invalid AIOMetadata URL' }
        }

        let configJson
        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 15000)
            let response
            try {
                response = await guardedWebFetch(targetUrl, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ password, addonPassword: addonPassword || undefined })
                })
            } finally {
                clearTimeout(timeout)
            }
            if (!response) {
                reply.status(502); return { error: 'Could not reach AIOMetadata instance' }
            }
            if (response.status >= 300 && response.status < 400) {
                reply.status(502); return { error: 'Could not reach AIOMetadata instance' }
            }
            if (response.status === 401 || response.status === 403) {
                reply.status(401); return { error: 'AIOMetadata authentication failed' }
            }
            if (response.status >= 400) {
                reply.status(502); return { error: 'Could not reach AIOMetadata instance' }
            }
            try {
                configJson = await response.json()
            } catch {
                reply.status(502); return { error: 'Could not reach AIOMetadata instance' }
            }
        } catch (err) {
            if (err && err.code === 'ssrf-blocked') { reply.status(400); return { error: 'Invalid AIOMetadata URL' } }
            const aborted = err && err.name === 'AbortError'
            fastify.log.warn({ category: 'MetadataKeys' }, `AIOMetadata import fetch failed: ${aborted ? 'timeout' : err.message}`)
            reply.status(502); return { error: 'Could not reach AIOMetadata instance' }
        }

        const configRoot = (configJson && typeof configJson === 'object')
            ? (configJson.config && typeof configJson.config === 'object' ? configJson.config : configJson)
            : null
        const apiKeys = configRoot && typeof configRoot.apiKeys === 'object' ? configRoot.apiKeys : null
        if (!apiKeys) {
            return { imported: [] }
        }

        const imported = []
        const now = Date.now()
        const saved = await withWorkspaceBinding(authUser, binding, async tx => {
            for (const [rawProvider, rawValue] of Object.entries(apiKeys)) {
                const provider = normalizeProvider(rawProvider)
                if (!provider) continue
                const keyStr = typeof rawValue === 'string'
                    ? rawValue.trim()
                    : (rawValue == null ? '' : String(rawValue).trim())
                if (!isValidKeyValue(keyStr)) continue
                const keyFormat = detectKeyFormat(keyStr)
                await upsertMetadataKey(tx, authUser, provider, encrypt(keyStr, PRIMARY_KEY), keyFormat, now)
                imported.push({ provider, keyFormat })
            }
        })
        if (!saved) { reply.status(401); return { error: 'Unauthorized' } }
        for (const { provider } of imported) invalidateUserKey(authUser, provider)

        fastify.log.info({ category: 'MetadataKeys' }, `Imported ${imported.length} metadata key(s) for user ${maskContext(authUser)} from AIOMetadata.`)
        return { imported }
    })
}
