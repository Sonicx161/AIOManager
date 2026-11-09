import db from '../db.js'
import { verifyAuth } from '../auth.js'
import { readAddonActions, recordAddonActions, withHydraAccountLock } from '../lib/addon-actions.js'
import { assertWritablePrimary } from '../admin/account-state.js'

const ErrorResponse = {
    type: 'object',
    required: ['error'],
    properties: { error: { type: 'string' } }
}

const MAX_DELETES_PER_REQUEST = 100
const MAX_URL_LENGTH = 2048
const MAX_TOKEN_LENGTH = 64
const MAX_QUERY_KEYS_PER_REQUEST = 200

const ActionRow = {
    type: 'object',
    required: ['urlKey', 'transportUrl', 'lastInstallAt', 'lastDeleteAt', 'installSeq', 'deleteSeq', 'deleteToken'],
    properties: {
        urlKey: { type: 'string', description: 'The requested normalized addon URL key (tombstone key space)' },
        transportUrl: { type: 'string', description: 'Transport URL of the latest install' },
        lastInstallAt: { type: ['number', 'null'], description: 'Server Unix epoch (ms) of the latest install' },
        lastDeleteAt: { type: ['number', 'null'], description: 'Server Unix epoch (ms) of the latest delete' },
        installSeq: { type: 'number', description: 'Row sequence of the latest install; compared against deleteSeq for eligibility' },
        deleteSeq: { type: 'number', description: 'Row sequence of the latest delete; compared against installSeq for eligibility' },
        deleteToken: { type: ['string', 'null'], description: 'Client deletion identity the delete acknowledged' }
    }
}

const ActionsResponse = {
    type: 'object',
    required: ['actions'],
    properties: {
        actions: {
            type: 'array',
            description: 'Newest activity first',
            items: ActionRow
        }
    }
}

export function registerAddonActionRoutes(fastify) {
    fastify.post('/api/addon-actions/query', {
        bodyLimit: 1024 * 512,
        config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
        schema: {
            tags: ['addon-actions'],
            summary: 'Every install and acknowledged delete for the requested addon url keys',
            body: {
                type: 'object',
                required: ['accountId', 'urlKeys'],
                properties: {
                    accountId: { type: 'string', description: 'Account id the actions belong to' },
                    urlKeys: {
                        type: 'array',
                        maxItems: MAX_QUERY_KEYS_PER_REQUEST,
                        description: 'Normalized addon URL keys (tombstone key space), up to 200 per request; over-long keys are skipped',
                        items: { type: 'string' }
                    }
                }
            },
            response: {
                200: {
                    ...ActionsResponse,
                    properties: {
                        actions: {
                            ...ActionsResponse.properties.actions,
                            description: 'Every row for the requested keys, newest activity first, no cap'
                        }
                    }
                },
                400: ErrorResponse,
                401: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const accountId = String(request.body?.accountId || '')
        if (!accountId) { reply.code(400); return { error: 'Missing accountId' } }
        const seen = new Set()
        const urlKeys = []
        for (const raw of request.body?.urlKeys || []) {
            const key = String(raw ?? '')
            // Per-key validation: one bad key must not fail the whole batch.
            if (!key || key.length > MAX_URL_LENGTH || seen.has(key)) continue
            seen.add(key)
            urlKeys.push(key)
        }
        if (urlKeys.length === 0) { reply.code(400); return { error: 'Missing urlKeys' } }

        try {
            const actions = await readAddonActions(authUser, accountId, urlKeys)
            return { actions }
        } catch (err) {
            fastify.log.error({ category: 'AddonActions' }, `Query failed: ${err.message}`)
            reply.code(500)
            return { error: 'Failed to read addon actions' }
        }
    })

    fastify.post('/api/addon-actions/delete', {
        bodyLimit: 1024 * 128,
        config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
        schema: {
            tags: ['addon-actions'],
            summary: 'Acknowledge client addon deletions on the server',
            body: {
                type: 'object',
                required: ['accountId', 'deletes'],
                properties: {
                    accountId: { type: 'string' },
                    deletes: {
                        type: 'array',
                        maxItems: MAX_DELETES_PER_REQUEST,
                        items: {
                            type: 'object',
                            required: ['url', 'token'],
                            properties: {
                                url: { type: 'string', maxLength: MAX_URL_LENGTH },
                                token: { type: 'string', maxLength: MAX_TOKEN_LENGTH }
                            }
                        }
                    }
                }
            },
            response: {
                200: {
                    type: 'object',
                    required: ['ok', 'recorded'],
                    properties: {
                        ok: { type: 'boolean' },
                        recorded: { type: 'number', description: 'Delete rows written' }
                    }
                },
                400: ErrorResponse,
                401: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        assertWritablePrimary()

        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const accountId = String(request.body?.accountId || '')
        const raw = Array.isArray(request.body?.deletes) ? request.body.deletes : []
        if (!accountId) { reply.code(400); return { error: 'Missing accountId' } }
        // Only accounts with an API key can ever receive Hydra installs, so an unknown
        // accountId is acknowledged without a write.
        const knownAccount = await db.get(
            'SELECT 1 FROM account_api_keys WHERE account_id = $1 AND sync_user = $2 LIMIT 1',
            [accountId, authUser]
        )
        if (!knownAccount) return { ok: true, recorded: 0 }
        const seen = new Set()
        const deletes = []
        for (const entry of raw) {
            const url = String(entry?.url || '').trim()
            const token = String(entry?.token ?? '').trim()
            const key = `${url}\u0000${token}`
            if (!url || url.length > MAX_URL_LENGTH || !token || token.length > MAX_TOKEN_LENGTH || seen.has(key)) continue
            seen.add(key)
            deletes.push({ url, token })
        }
        if (deletes.length === 0) { reply.code(400); return { error: 'Missing deletes' } }

        try {
            const recorded = await withHydraAccountLock({ sync_user: authUser, account_id: accountId }, () => db.tx(tx => recordAddonActions(tx, {
                syncUser: authUser,
                accountId,
                entries: deletes.map(d => ({ url: d.url, action: 'delete', token: d.token })),
                keysAreNormalized: true
            })))
            return { ok: true, recorded }
        } catch (err) {
            fastify.log.error({ category: 'AddonActions' }, `Delete failed: ${err.message}`)
            reply.code(500)
            return { error: 'Failed to record addon deletions' }
        }
    })
}
