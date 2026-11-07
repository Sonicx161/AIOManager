import crypto from 'crypto'
import db from '../db.js'
import { verifyAuth } from '../auth.js'
import { createStremioDriver } from '../providers/stremio-driver.js'
import { maskContext } from '../utils/log-helpers.js'
import { resolveStremioAuthKey } from '../lib/stremio-credentials.js'
import { assertAccountActive, assertWritablePrimary, gateCode } from '../admin/account-state.js'

// Phase 1b proof commands. Registry ids from src/components/accounts/bulk-actions/registry.ts
// are the command names; only the subset the server can execute on its own is wired here.
// protect-all / unprotect-all work by rewriting the account's Stremio addon collection
// (flags.protected round-trips through addonCollectionGet/Set - the client pushes the same
// shape), which requires a stored server credential for the account. Accounts without one
// are reported per-account as failed rather than blocking the job.
const COMMAND_HANDLERS = {
    'protect-all': (fastify, syncUser, accountId) => applyProtection(fastify, syncUser, accountId, true),
    'unprotect-all': (fastify, syncUser, accountId) => applyProtection(fastify, syncUser, accountId, false),
}

const MAX_ACCOUNTS_PER_JOB = 200
const ACCOUNT_CONCURRENCY = 3
const JOB_HISTORY_LIMIT = 100

const ErrorResponse = {
    type: 'object',
    required: ['error'],
    properties: { error: { type: 'string' } }
}

const CommandResult = {
    type: 'object',
    required: ['accountId', 'ok'],
    properties: {
        accountId: { type: 'string' },
        ok: { type: 'boolean' },
        error: { type: 'string', description: 'Present when ok is false' },
        changed: { type: 'number', description: 'Addons whose protection flag changed' },
        total: { type: 'number', description: 'Addons in the account collection' }
    }
}

const JobStatus = { type: 'string', enum: ['queued', 'running', 'completed', 'failed'] }

async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length)
    let cursor = 0
    async function lane() {
        while (cursor < items.length) {
            const index = cursor++
            results[index] = await worker(items[index])
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, lane))
    return results
}

async function applyProtection(fastify, syncUser, accountId, isProtected) {
    const authKey = await resolveStremioAuthKey(accountId, syncUser)
    if (!authKey) {
        return {
            accountId,
            ok: false,
            error: 'No server-side Stremio credential for this account. Connect it (Connections tab or autopilot rule) so the server can act on it.'
        }
    }

    const driver = createStremioDriver()
    const addons = await driver.readAddons(authKey)
    let changed = 0
    const updatedAddons = (addons || []).map((addon) => {
        const alreadyProtected = Boolean(addon?.flags?.protected)
        if (alreadyProtected === isProtected) return addon
        changed++
        return { ...addon, flags: { ...addon?.flags, protected: isProtected } }
    })
    if (changed > 0) {
        await driver.writeAddons(authKey, updatedAddons)
    }
    return { accountId, ok: true, changed, total: updatedAddons.length }
}

// Jobs are rare bulk operations, so v1 runs them sequentially (one at a time) while each
// job fans out over its accounts with a small lane pool to avoid hammering Stremio.
// queueTail always resolves so one crashed job can never poison the chain for later jobs.
let queueTail = Promise.resolve()

function enqueueJob(fastify, jobId) {
    const run = queueTail.then(() => runJob(fastify, jobId))
    queueTail = run.catch(() => {})
    return run
}

async function runJob(fastify, jobId) {
    let job = null
    let accountIds = []
    try {
        job = await db.get('SELECT id, sync_user, command, account_ids FROM commands WHERE id = $1', [jobId])
        if (!job) return

        try { accountIds = JSON.parse(job.account_ids) || [] } catch { accountIds = [] }

        // Account state gate: the owner may have been blocked between enqueue and run.
        // A dedicated refusal records a non-write failure; the driver is never created.
        try {
            await assertAccountActive(job.sync_user)
        } catch (stateErr) {
            const code = gateCode(stateErr)
            if (code) {
                fastify.log.warn({ category: 'Commands' }, `Job ${jobId} (${job.command}) refused for user ${maskContext(job.sync_user || '')}: ${code}.`)
                await db.run(
                    `UPDATE commands SET status = 'failed', error = $1, updated_at = $2 WHERE id = $3`,
                    [code, Date.now(), jobId]
                ).catch((updateErr) => fastify.log.error({ category: 'Commands' }, `Job ${jobId} status update failed: ${updateErr?.message}`))
                return
            }
            throw stateErr
        }

        const now = Date.now()
        await db.run(`UPDATE commands SET status = 'running', updated_at = $1 WHERE id = $2`, [now, jobId])
        fastify.log.info({ category: 'Commands' }, `Job ${jobId} (${job.command}) running for ${accountIds.length} account(s).`)
    } catch (err) {
        // Startup failure: mark the row failed so it can never sit 'queued' forever (the boot sweep is the backstop).
        fastify.log.error({ category: 'Commands' }, `Job ${jobId} failed to start: ${err?.message}`)
        await db.run(
            `UPDATE commands SET status = 'failed', error = $1, updated_at = $2 WHERE id = $3`,
            [err?.message || 'Job failed to start', Date.now(), jobId]
        ).catch((updateErr) => fastify.log.error({ category: 'Commands' }, `Job ${jobId} status update failed: ${updateErr?.message}`))
        return
    }

    try {
        const handler = COMMAND_HANDLERS[job.command]
        if (!handler) throw new Error(`Unknown command: ${job.command}`)

        const results = await runWithConcurrency(accountIds, ACCOUNT_CONCURRENCY, async (accountId) => {
            try {
                // Per-account re-assert: the owner may be blocked while lanes run.
                await assertAccountActive(job.sync_user)
            } catch (stateErr) {
                const code = gateCode(stateErr)
                if (code) return { accountId, ok: false, error: code }
                throw stateErr
            }
            try {
                return await handler(fastify, job.sync_user, accountId)
            } catch (err) {
                const authExpired = err?._authExpired ? ' (auth key rejected - re-authenticate the connection)' : ''
                return { accountId, ok: false, error: `${err?.message || 'Account command failed'}${authExpired}` }
            }
        })

        const completedAt = Date.now()
        await db.run(
            `UPDATE commands SET status = 'completed', results = $1, error = NULL, updated_at = $2 WHERE id = $3`,
            [JSON.stringify(results), completedAt, jobId]
        )
        const failed = results.filter(r => !r.ok).length
        fastify.log.info({ category: 'Commands' }, `Job ${jobId} completed: ${results.length - failed} ok, ${failed} failed.`)

        await pruneJobHistory(fastify)
    } catch (err) {
        const failedAt = Date.now()
        fastify.log.error({ category: 'Commands' }, `Job ${jobId} failed: ${err?.message}`)
        await db.run(
            `UPDATE commands SET status = 'failed', error = $1, updated_at = $2 WHERE id = $3`,
            [err?.message || 'Job failed', failedAt, jobId]
        ).catch((updateErr) => fastify.log.error({ category: 'Commands' }, `Job ${jobId} status update failed: ${updateErr?.message}`))
    }
}

async function pruneJobHistory(fastify) {
    try {
        const cutoff = await db.get(
            `SELECT updated_at AS ts FROM commands ORDER BY updated_at DESC LIMIT 1 OFFSET ${JOB_HISTORY_LIMIT}`
        )
        if (cutoff?.ts) {
            await db.run(`DELETE FROM commands WHERE updated_at <= $1`, [cutoff.ts])
        }
    } catch (err) {
        fastify.log.warn({ category: 'Commands' }, `Job history prune failed: ${err?.message}`)
    }
}

function serializeJob(row) {
    let results = null
    if (row.results) {
        try { results = JSON.parse(row.results) } catch { results = null }
    }
    return {
        jobId: row.id,
        command: row.command,
        status: row.status,
        results,
        error: row.error || undefined,
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0
    }
}

export function registerCommandsRoutes(fastify) {
    fastify.post('/api/commands', {
        bodyLimit: 1024 * 16,
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        schema: {
            tags: ['commands'],
            summary: 'Enqueue a bulk account command (protect-all, unprotect-all)',
            body: {
                type: 'object',
                required: ['id', 'accountIds'],
                properties: {
                    id: { type: 'string', enum: Object.keys(COMMAND_HANDLERS), description: 'Command id (matches the client bulk-action registry)' },
                    accountIds: {
                        type: 'array',
                        items: { type: 'string', minLength: 1 },
                        minItems: 1,
                        maxItems: 200,
                        description: 'Account ids the command should run against'
                    }
                }
            },
            response: {
                200: {
                    type: 'object',
                    required: ['jobId', 'status'],
                    properties: {
                        jobId: { type: 'string', description: 'Job id for polling GET /api/commands/:jobId' },
                        status: { type: 'string', enum: ['queued'] }
                    }
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

        const { id: command, accountIds } = request.body || {}
        if (!Object.prototype.hasOwnProperty.call(COMMAND_HANDLERS, command)) {
            reply.status(400); return { error: `Unsupported command: ${String(command)}` }
        }
        if (!Array.isArray(accountIds) || accountIds.length === 0) {
            reply.status(400); return { error: 'accountIds must be a non-empty array' }
        }
        if (accountIds.length > MAX_ACCOUNTS_PER_JOB) {
            reply.status(400); return { error: `Too many accounts (max ${MAX_ACCOUNTS_PER_JOB})` }
        }
        const uniqueAccountIds = [...new Set(accountIds.filter(a => typeof a === 'string' && a.length > 0))]
        if (uniqueAccountIds.length === 0) {
            reply.status(400); return { error: 'accountIds must contain at least one non-empty string' }
        }

        const jobId = crypto.randomUUID()
        const now = Date.now()
        try {
            await db.run(
                `INSERT INTO commands (id, sync_user, command, account_ids, status, results, error, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'queued', NULL, NULL, $5, $6)`,
                [jobId, authUser, command, JSON.stringify(uniqueAccountIds), now, now]
            )
        } catch (err) {
            fastify.log.error({ category: 'Commands' }, `Job insert failed for ${command}: ${err.message}`)
            reply.status(500); return { error: 'Failed to enqueue command' }
        }

        enqueueJob(fastify, jobId).catch((err) => {
            fastify.log.error({ category: 'Commands' }, `Job runner crashed for ${jobId}: ${err?.message || err}`)
        })

        fastify.log.info({ category: 'Commands' }, `Queued ${command} job ${jobId} (${uniqueAccountIds.length} account(s)) for user ${maskContext(authUser)}.`)
        return { jobId, status: 'queued' }
    })

    fastify.get('/api/commands/:jobId', {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        schema: {
            tags: ['commands'],
            summary: 'Poll a command job status and per-account results',
            params: {
                type: 'object',
                required: ['jobId'],
                properties: { jobId: { type: 'string', minLength: 1 } }
            },
            response: {
                200: {
                    type: 'object',
                    required: ['jobId', 'command', 'status'],
                    properties: {
                        jobId: { type: 'string' },
                        command: { type: 'string' },
                        status: JobStatus,
                        results: { type: ['array', 'null'], items: CommandResult },
                        error: { type: 'string' },
                        createdAt: { type: 'number', description: 'Unix epoch (ms)' },
                        updatedAt: { type: 'number', description: 'Unix epoch (ms)' }
                    }
                },
                400: ErrorResponse,
                401: ErrorResponse,
                404: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const jobId = request.params?.jobId
        if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 64) {
            reply.status(400); return { error: 'Invalid job id' }
        }

        const row = await db.get(
            'SELECT id, command, status, results, error, created_at, updated_at FROM commands WHERE id = $1 AND sync_user = $2',
            [jobId, authUser]
        )
        if (!row) {
            reply.status(404); return { error: 'Job not found' }
        }
        return serializeJob(row)
    })
}
