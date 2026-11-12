import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import fastifyCompress from '@fastify/compress'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import { rateLimitKey } from './utils/rate-limit-key.js'
import db from './db.js'
import fs from 'fs'
import { logFormatters } from './admin/log-fields.js'
import { VERSION, PORT, loggerConfig, distPath, corsOrigins, ensureDataDirectory, isReadOnlyReplica } from './config.js'
import { initializeEncryptionKeys } from './keys.js'
import { proxyQueue, serverState } from './state.js'
import { initializeDatabase } from './database/setup.js'
import { registerSyncRoutes } from './routes/sync.js'
import { registerProxyRoutes } from './routes/proxy.js'
import { registerAutopilotRoutes } from './routes/autopilot.js'
import { createAutopilotEngine } from './autopilot/engine.js'
import { autopilotTripwire } from './autopilot/write-tripwire.js'
import { createActivityEngine } from './activity/engine.js'
import { registerActivityRoutes } from './routes/activity.js'
import { registerHydraRoutes } from './routes/hydra.js'
import { createReconciler } from './providers/reconciler.js'
import { registerProviderRoutes } from './routes/providers.js'
import { autopilotWorkerEnabled } from './lib/autopilot-worker.js'
import { registerMetadataKeysRoutes } from './routes/metadata-keys.js'
import { registerMetadataProxyRoutes } from './routes/metadata-proxy.js'
import { registerAddonActionRoutes } from './routes/addon-actions.js'
import { registerCommandsRoutes } from './routes/commands.js'
import { registerWatchlistRoutes } from './routes/watchlist.js'
import { registerDeviceCredentialRoutes } from './routes/device-credentials.js'
import { deviceAuthHook } from './auth.js'
import { registerAdminRoutes } from './routes/admin.js'
import { isAdminEnabled } from './admin/config.js'
import { fastifyTrustProxy } from './admin/net.js'
import { isDashboardSpaPath } from './admin/paths.js'
import { corsDelegator } from './lib/cors-policy.js'
import { warnUnpinnedPublicProxy } from './lib/proxy-trust-warn.js'
import { publicConfig } from './lib/public-config.js'
import { reapplyStoredLiveSettings } from './lib/settings-boot.js'
import { serverErrorHandler } from './lib/error-reply.js'
import { registerAccountNoticeRoutes } from './admin/account-actions.js'

import { traceClientBatch, traceEnabled } from './utils/trace.js'

const fastify = Fastify({
    logger: { ...loggerConfig, formatters: logFormatters },
    disableRequestLogging: true,
    bodyLimit: parseInt(process.env.MAX_SYNC_PAYLOAD_SIZE || '104857600'),
    trustProxy: fastifyTrustProxy()
})

fastify.setErrorHandler(serverErrorHandler)

// With request logging off and error-reply logging 5xx only, debug/trace is the only window on what answered >=400 in front of the app.
fastify.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 400 || !fastify.log.isLevelEnabled('debug')) return
    fastify.log.debug({ category: 'Server', method: request.method, route: request.routeOptions?.url, status: reply.statusCode, responseTime: reply.elapsedTime }, 'Rejected request')
})

ensureDataDirectory(fastify)
initializeEncryptionKeys(fastify)

if (process.env.CUSTOM_HTML) {
    fastify.log.info({ category: 'Server' }, 'Custom HTML injection active.')
}

const dbPath = await initializeDatabase(fastify)
await reapplyStoredLiveSettings(db, { logger: fastify.log, log: console })

// The Dashboard API never takes cross-origin requests, preflight included.
await fastify.register(cors, {
    delegator: corsDelegator(corsOrigins)
})

await fastify.register(rateLimit, {
    global: false,
    keyGenerator: rateLimitKey
})

await fastify.register(fastifyCompress, { global: true })

// OpenAPI contract: routes that declare JSON schemas are reflected into the spec at
// /openapi.json. Deliberately exposed in ALL environments (not just dev): the spec
// itself is not sensitive (every documented route still requires sync auth), and the
// client build + CI drift check consume it from a running instance unauthenticated.
await fastify.register(swagger, {
    openapi: {
        openapi: '3.1.0',
        info: {
            title: 'AIOManager API',
            description: 'Hybrid sync server for AIOManager. Served same-origin under /api/*.',
            version: VERSION
        },
        servers: [{ url: '/' }],
        tags: [
            { name: 'metadata-keys', description: 'User-scoped metadata provider API key storage' },
            { name: 'metadata', description: 'Metadata proxy and API key testing' },
            { name: 'commands', description: 'Server-side bulk account command queue (jobs with per-account results)' }
        ]
    }
})

// @fastify/swagger only generates the spec (fastify.swagger()); the JSON is served
// here. Must come after the swagger plugin registration and before other routes.
fastify.get('/openapi.json', { schema: { hide: true } }, async () => fastify.swagger())

fastify.addHook('onRequest', async (request) => {
    request.startTime = Date.now()
})

// Once per start: forwarded headers that reveal an unrecognised public proxy (directly
// connected, or forwarding through a trusted local proxy) mean its visitors share one
// rate limit and one sign-in lockout. Warn in plain words before anything else runs.
fastify.addHook('onRequest', async (request) => {
    warnUnpinnedPublicProxy(request, fastify.log)
})

fastify.addHook('onRequest', deviceAuthHook)

fastify.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'sha256-VN34VPJNWWUVbM4xY2D3keH3SKndwOBBSBXDjlfA5nU=' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https: http:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; font-src 'self' https://fonts.gstatic.com; frame-src 'self' https://www.youtube.com https://youtube.com; frame-ancestors 'none'; base-uri 'self'; form-action 'none'")
    if (request.protocol === 'https') {
        reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    const start = request.startTime
    if (typeof start === 'number') {
        const timings = []
        if (request.tmdbDuration) timings.push(`tmdb;dur=${Math.round(request.tmdbDuration)}`)
        if (request.dbDuration) timings.push(`db;dur=${Math.round(request.dbDuration)}`)
        timings.push(`total;dur=${Math.round(Date.now() - start)}`)
        reply.header('Server-Timing', timings.join(', '))
    }
})

registerWatchlistRoutes(fastify)
registerDeviceCredentialRoutes(fastify)

fastify.get('/logo.png', async (_request, reply) => {
    const distLogo = `${distPath}/logo.png`
    const publicLogo = `${distPath.replace(/\/dist$/, '')}/public/logo.png`
    if (fs.existsSync(distLogo)) {
        reply.type('image/png')
        return reply.send(fs.createReadStream(distLogo))
    }
    if (fs.existsSync(publicLogo)) {
        reply.type('image/png')
        return reply.send(fs.createReadStream(publicLogo))
    }
    reply.status(404)
    return { error: 'Logo not found' }
})

if (fs.existsSync(distPath)) {
    await fastify.register(fastifyStatic, {
        root: distPath,
        prefix: '/',
        cacheControl: false,
        preCompressed: true,
        // @fastify/static 10 hands setHeaders the Fastify reply, not Node's
        // ServerResponse; raw res.setHeader throws on every static file.
        setHeaders: (reply, path) => {
            const assetPath = path.replace(/\.(br|gz)$/, '')
            if (assetPath.endsWith('.html')) reply.header('Cache-Control', 'no-cache')
            // Cache hashed assets permanently; HTML and unhashed files must revalidate.
            else if (/[\\/]assets[\\/][^\\/]*-[A-Za-z0-9_-]{8,}\.[^\\/]+$/.test(assetPath)) reply.header('Cache-Control', 'public, max-age=31536000, immutable')
            else reply.header('Cache-Control', 'public, max-age=0')
        }
    })

    fastify.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api') || (!isAdminEnabled() && isDashboardSpaPath(request.url))) {
            reply.status(404);
            return { error: `API route ${request.method}:${request.url} not found` }
        }
        // A missing build asset must never fall through to the SPA document.
        // Returning index.html for an old hashed chunk makes the browser report
        // a misleading module error and gives an intermediary a chance to cache
        // HTML under a JavaScript URL.
        if (request.url.startsWith('/assets/')) {
            reply.header('Cache-Control', 'no-store')
            reply.status(404)
            return { error: 'Static asset not found' }
        }
        reply.header('Cache-Control', 'no-cache')
        return reply.sendFile('index.html')
    })

}

fastify.get('/api/health', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
        response: {
            200: {
                type: 'object',
                properties: {
                    status: { type: 'string' },
                    version: { type: 'string' },
                    mode: { type: 'string' },
                    readOnly: { type: 'boolean' },
                    optimized: { type: 'boolean' },
                    capabilities: {
                        type: 'object',
                        properties: {
                            canonicalAddonsV2: { type: 'boolean' },
                            canonicalAddonsV2Ack: { type: 'boolean' }
                        }
                    },
                    database: {
                        type: 'object',
                        properties: {
                            type: { type: 'string' },
                            healthy: { type: 'boolean' }
                        }
                    },
                    autopilot: {
                        type: 'object',
                        properties: {
                            lastRun: { type: 'number' },
                            running: { type: 'boolean' },
                            safeMode: {
                                type: ['object', 'null'],
                                properties: {
                                    since: { type: 'number' },
                                    reason: { type: 'string' },
                                    statements: { type: 'number' },
                                    bytes: { type: 'number' }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}, async (request, reply) => {
    const dbHealthy = await db.healthCheck()
    const overallStatus = dbHealthy ? 'ok' : 'degraded'
    const readOnly = isReadOnlyReplica()
    const mode = readOnly ? 'read-only-replica' : 'multi-tenant'

    if (!dbHealthy) {
        reply.status(503);
        return {
            status: 'degraded',
            version: VERSION,
            mode,
            readOnly,
            optimized: true,
            database: { type: db.type, healthy: false },
            autopilot: { lastRun: serverState.lastWorkerRun, running: serverState.isWorkerRunning, safeMode: autopilotTripwire.status() }
        }
    }

    return {
        status: overallStatus,
        version: VERSION,
        mode,
        readOnly,
        optimized: true,
        capabilities: { canonicalAddonsV2: true, canonicalAddonsV2Ack: true },
        database: { type: db.type, healthy: true },
        autopilot: { lastRun: serverState.lastWorkerRun, running: serverState.isWorkerRunning, safeMode: autopilotTripwire.status() }
    }
})

// Write-readiness probe for status-code-only load balancers: a read-only standby (or an
// unhealthy DB) returns 503 so it is excluded from write routing, while /api/health stays
// 200 to keep the standby reachable for read traffic.
fastify.get('/api/ready', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
        response: {
            200: { type: 'object', properties: { ready: { type: 'boolean' }, readOnly: { type: 'boolean' } } },
            503: { type: 'object', properties: { ready: { type: 'boolean' }, readOnly: { type: 'boolean' } } }
        }
    }
}, async (request, reply) => {
    const readOnly = isReadOnlyReplica()
    const dbHealthy = await db.healthCheck()
    if (readOnly || !dbHealthy) {
        reply.status(503)
        return { ready: false, readOnly }
    }
    return { ready: true, readOnly }
})

fastify.get('/api/config', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const payload = publicConfig()
    const etag = `W/"${createHash('sha1').update(JSON.stringify(payload)).digest('base64url')}"`
    reply.header('Cache-Control', 'no-cache, public')
    reply.header('ETag', etag)
    const requestCacheControl = request.headers['cache-control']
    if (typeof requestCacheControl === 'string' && requestCacheControl.includes('no-cache')) return payload
    if (request.headers['if-none-match'] === etag || request.headers['if-none-match'] === '*') {
        reply.status(304)
        return null
    }
    return payload
})

// Debug trace sink: client seams batch-POST here so client + server traces land in one
fastify.post('/api/debug/trace', { bodyLimit: 1024 * 1024, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!traceEnabled()) {
        reply.status(204)
        return null
    }
    traceClientBatch(request.body?.entries)
    reply.status(204)
    return null
})

registerSyncRoutes(fastify)
registerAccountNoticeRoutes(fastify)

const reconciler = createReconciler(fastify)
const autopilotEngine = createAutopilotEngine(fastify, reconciler)
const activityEngine = createActivityEngine(fastify)
await registerAdminRoutes(fastify, { autopilotEngine, activityEngine, reconciler })
registerProxyRoutes(fastify, { checkAddonHealthInternal: autopilotEngine.checkAddonHealthInternal })

const start = async () => {
    try {
        const banner = `
 ==============================================================================
      ___   _ _______  __  __
     /   | (_) ____/ |/ / / /___ _____  ____ _____ ____  _____
    / /| |/ / /   / /|_/ / __ \`/ __ \`/ __ \`/ __ \`/ _ \\/ ___/
   / ___ / / /___/ /  / / /_/ / / / / /_/ / /_/ /  __/ /
  /_/  |_\\_\\____/_/  /_/\\__,_/_/ /_/\\__,/\\__, /\\___/_/
                                         /____/
 ==============================================================================
  One manager to rule them all. Local-first, Encrypted, Powerful. v${VERSION}
 ==============================================================================
`;
        console.log(banner);

        registerAutopilotRoutes(fastify, autopilotEngine)
        registerActivityRoutes(fastify, activityEngine)
        registerHydraRoutes(fastify, reconciler)
        registerProviderRoutes(fastify, reconciler)
        registerMetadataKeysRoutes(fastify)
        registerMetadataProxyRoutes(fastify)
        registerAddonActionRoutes(fastify)
        registerCommandsRoutes(fastify)

        await fastify.listen({ port: PORT, host: '0.0.0.0' })
        fastify.log.info({ category: 'Server' }, `Listening on port ${PORT}`)
        if (db.type === 'sqlite') {
            fastify.log.info({ category: 'Database' }, `Path: ${dbPath}`)
        }
        fastify.log.info({ category: 'Security' }, 'Zero-Knowledge mode active. 🛡️')

        if (isReadOnlyReplica()) {
            fastify.log.info({ category: 'Server' }, 'READ_ONLY_REPLICA mode: passive standby, autopilot and activity workers disabled. Serving read traffic only.')
        } else {
            const autopilotWorkerRaw = String(process.env.AUTOPILOT_WORKER || '').trim().toLowerCase()
            const autopilotWorkerOn = autopilotWorkerEnabled(autopilotWorkerRaw)
            if (!autopilotWorkerOn) {
                fastify.log.info({ category: 'Autopilot' }, 'Autopilot worker disabled via AUTOPILOT_WORKER=off.')
            } else if (autopilotWorkerRaw !== '') {
                fastify.log.warn({ category: 'Autopilot' }, 'Unrecognized AUTOPILOT_WORKER value; starting the worker.')
            }
            if (autopilotWorkerOn) autopilotEngine.startAutopilotWorker()
            activityEngine.start()
        }
    } catch (err) {
        fastify.log.error(err)
        process.exit(1)
    }
}

const shutdown = async (signal) => {
    console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`)

    try {
        autopilotEngine.stopAutopilotWorker()
        activityEngine.stop()
        proxyQueue.length = 0

        if (serverState.isWorkerRunning) {
            fastify.log.info({ category: 'Server' }, 'Waiting for autopilot worker to finish...')
            for (let i = 0; i < 30 && serverState.isWorkerRunning; i++) {
                await new Promise(r => setTimeout(r, 1000))
            }
            if (serverState.isWorkerRunning) {
                fastify.log.warn({ category: 'Server' }, 'Worker still running after 30s, proceeding with shutdown.')
            }
        }

        await fastify.close()
        fastify.log.info({ category: 'Server' }, 'Fastify closed.')

        if (db) {
            fastify.log.info({ category: 'Database' }, 'Flushing and closing...')
            if (db.type === 'sqlite') {
                await db.pragma('wal_checkpoint(TRUNCATE)')
            }
            await db.close()
            fastify.log.info({ category: 'Database' }, 'Database connection closed cleanly.')
        }

        process.exit(0)
    } catch (err) {
        fastify.log.error({ category: 'Server' }, `Error during shutdown: ${err.message}`)
        process.exit(1)
    }
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
const formatFatalError = (err) => {
    if (err instanceof Error) return err.stack || err.message
    if (err && typeof err === 'object') {
        try { return JSON.stringify(err) } catch { return String(err) }
    }
    return String(err)
}
process.on('unhandledRejection', (reason) => {
    fastify.log.error({ category: 'Server' }, `Unhandled promise rejection: ${formatFatalError(reason)}`)
})
process.on('uncaughtException', (err) => {
    fastify.log.error({ category: 'Server' }, `Uncaught exception: ${formatFatalError(err)}`)
    shutdown('uncaughtException')
})

start()
