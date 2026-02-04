import Fastify from 'fastify'
import pinoPretty from 'pino-pretty'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import fastifyCompress from '@fastify/compress'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// --- Configuration ---
const PORT = process.env.PORT || 1610
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const PROXY_CONCURRENCY_LIMIT = parseInt(process.env.PROXY_CONCURRENCY_LIMIT || '20') // Increased from 5 to 20 for faster parallel updates
const DOMAIN_THROTTLE_MS = 200

// --- Proxy Concurrency & Throttling Management ---
const proxyQueue = []
let activeProxyRequests = 0
const domainLastRequestTime = new Map()

const processQueue = async () => {
    if (proxyQueue.length === 0 || activeProxyRequests >= PROXY_CONCURRENCY_LIMIT) return

    const request = proxyQueue.shift()
    const { task, resolve, reject, url } = request

    let origin = ''
    try {
        origin = new URL(url).origin
    } catch (e) { origin = url }

    // Domain Throttling: Check if we need to wait
    const now = Date.now()
    const lastRequest = domainLastRequestTime.get(origin) || 0
    const waitTime = Math.max(0, DOMAIN_THROTTLE_MS - (now - lastRequest))

    if (waitTime > 0) {
        // Put it back in the queue and wait
        proxyQueue.push(request)
        setTimeout(processQueue, 100)
        return
    }

    // Mark domain as busy
    domainLastRequestTime.set(origin, now)
    activeProxyRequests++

    try {
        const result = await task()
        resolve(result)
    } catch (err) {
        reject(err)
    } finally {
        activeProxyRequests--
        processQueue()
    }
}

const enqueueProxyRequest = (url, task) => {
    return new Promise((resolve, reject) => {
        proxyQueue.push({ url, task, resolve, reject })
        processQueue()
    })
}

// --- Server Setup ---
const loggerConfig = process.env.LOG_PRETTY_PRINT !== 'false' ? {
    stream: pinoPretty({
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname,level,category', // Ignore internal fields to keep message clean
        singleLine: true,
        messageFormat: (log, messageKey) => {
            const levelEmoji = log.level === 30 ? '🔵' : log.level === 40 ? '⚠️' : log.level >= 50 ? '❌' : '📝'
            const levelText = log.level === 30 ? 'INFO ' : log.level === 40 ? 'WARN ' : log.level >= 50 ? 'ERROR' : 'LOG  '

            // Category Mapping with Emojis
            const categoryMap = {
                'Database': '🗄️ DB   ',
                'Server': '💻 SRV  ',
                'Sync': '🔄 SYNC ',
                'MetaProxy': '🌐 PROXY',
                'Proxy': '🌐 PROXY',
                'Security': '🛡️ SEC  '
            }
            const category = categoryMap[log.category] || (log.category ? `📦 ${log.category.padEnd(6)}` : '🚀 MAIN ')

            return `${levelEmoji} ${levelText} | ${category} | ${log[messageKey]}`
        }
    })
} : true

const fastify = Fastify({
    logger: loggerConfig,
    bodyLimit: parseInt(process.env.MAX_SYNC_PAYLOAD_SIZE || '104857600')
})

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fastify.log.info({ category: 'Server' }, `Data directory not found, creating: ${DATA_DIR}`)
}

// --- Database Setup ---
const dbPath = path.join(DATA_DIR, 'aio.db')
fastify.log.info({ category: 'Database' }, `Initializing SQLite at: ${dbPath}`)
const db = new Database(dbPath)

// SQLite Performance & Stability Optimizations
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('temp_store = MEMORY')
db.pragma('cache_size = -2000') // 2MB cache
db.pragma('auto_vacuum = INCREMENTAL') // Keeps file small over time

// Run a manual vacuum on startup to clean up bloat if needed
fastify.log.info({ category: 'Database' }, 'Running startup maintenance (VACUUM)...')
db.exec('VACUUM')

// Initialize Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT,
    password TEXT,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS autopilot_rules (
    id TEXT PRIMARY KEY,
    account_id TEXT,
    auth_key TEXT,
    priority_chain TEXT, -- JSON array of URLs
    active_url TEXT,
    stabilization TEXT,  -- JSON object for success counts
    is_active INTEGER DEFAULT 1,
    last_check INTEGER,
    updated_at INTEGER
  );
`)

// Register CORS
await fastify.register(cors, {
    origin: true
})

// Register Gzip Compression (Reduces network payload size by ~80%)
await fastify.register(fastifyCompress, { global: true })

// Serve Static Files
const distPath = path.join(__dirname, '../dist')
if (fs.existsSync(distPath)) {
    await fastify.register(fastifyStatic, {
        root: distPath,
        prefix: '/'
    })

    // SPA Routing: Fallback to index.html for all non-API 404s
    fastify.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api')) {
            return reply.code(404).send({ error: `API route ${request.method}:${request.url} not found` })
        }
        return reply.sendFile('index.html')
    })
}

// --- API Routes ---

// Health Check
fastify.get('/api/health', {
    schema: {
        response: {
            200: {
                type: 'object',
                properties: {
                    status: { type: 'string' },
                    version: { type: 'string' },
                    mode: { type: 'string' },
                    optimized: { type: 'boolean' }
                }
            }
        }
    }
}, async () => {
    return { status: 'ok', version: '1.5.0', mode: 'multi-tenant', optimized: true }
})

// SYNC: Get State (Download)
fastify.get('/api/sync/:id', {
    schema: {
        params: {
            type: 'object',
            properties: {
                id: { type: 'string' }
            }
        },
        response: {
            200: {
                type: 'object',
                additionalProperties: true // Sync data is dynamic
            }
        }
    }
}, async (request, reply) => {
    const { id } = request.params
    const password = request.headers['x-sync-password']

    if (!id || !password) {
        return reply.code(400).send({ error: 'Missing ID or Password header' })
    }

    const stmt = db.prepare('SELECT value, password FROM kv_store WHERE key = ?')
    const row = stmt.get(id)

    if (!row) {
        return reply.code(404).send({ error: 'Not found' })
    }

    if (row.password !== password) {
        return reply.code(401).send({ error: 'Unauthorized: Invalid Password' })
    }

    return reply.send(row.value ? JSON.parse(row.value) : {})
})


// PROXY: Simple Metadata/Manifest Proxy (Bypass CORS via internal server)
fastify.get('/api/meta-proxy', {
    schema: {
        querystring: {
            type: 'object',
            required: ['url'],
            properties: {
                url: { type: 'string', format: 'uri' }
            }
        }
    }
}, async (request, reply) => {
    const { url } = request.query
    const accountContext = request.headers['x-account-context'] || 'Unknown'
    fastify.log.info({ category: 'MetaProxy' }, `[${accountContext}] Proxying request to: ${url}`)

    return enqueueProxyRequest(url, async () => {
        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 5000) // Reduced from 8s to 5s to unblock queue faster

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'AIOManager/1.2 (Internal Proxy; Hardened)'
                }
            })

            clearTimeout(timeout)

            if (!response.ok) {
                return reply.code(response.status).send({ error: `Upstream returned ${response.status}` })
            }

            const contentType = response.headers.get('content-type')
            if (contentType) reply.type(contentType)

            return reply.send(response.body)
        } catch (err) {
            if (err.name === 'AbortError') {
                fastify.log.error({ category: 'MetaProxy' }, `Timeout after 5s: ${url}`)
                return reply.code(504).send({ error: 'Gateway Timeout', details: 'Upstream addon took too long to respond (>5s)' })
            }
            fastify.log.error({ category: 'MetaProxy' }, `Failed to fetch ${url}: ${err.message}`)
            return reply.code(500).send({ error: 'Internal Proxy Error', details: err.message })
        }
    })
})

// PROXY: Stremio API Proxy (Enables backend logging of Stremio activities)
fastify.post('/api/stremio-proxy', {
    schema: {
        body: {
            type: 'object',
            required: ['type'],
            additionalProperties: true
        }
    }
}, async (request, reply) => {
    const { type, ...payload } = request.body
    const accountContext = request.headers['x-account-context'] || 'Unknown'

    if (type === 'AddonCollectionGet') {
        fastify.log.info({ category: 'Sync' }, `[${accountContext}] Refreshing addon collection from Stremio...`)
    } else if (type === 'AddonCollectionSet') {
        fastify.log.info({ category: 'Sync' }, `[${accountContext}] Pushing updated collection to Stremio (${payload.addons?.length || 0} addons)`)
    } else {
        fastify.log.info({ category: 'Server' }, `[Proxy] Relaying Stremio API call: ${type}`)
    }

    try {
        const response = await fetch('https://api.strem.io/api/' + type.charAt(0).toLowerCase() + type.slice(1), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, ...payload })
        })

        const data = await response.json()
        return reply.send(data)
    } catch (err) {
        fastify.log.error({ category: 'Server' }, `Stremio Proxy Error (${type}): ${err.message}`)
        return reply.code(500).send({ error: 'Stremio API Proxy Failed', details: err.message })
    }
})

// SYNC: Save State (Claim or Update)
fastify.post('/api/sync/:id', {
    schema: {
        params: {
            type: 'object',
            properties: { id: { type: 'string' } }
        },
        body: {
            type: 'object',
            additionalProperties: true
        }
    }
}, async (request, reply) => {
    const { id } = request.params
    const password = request.headers['x-sync-password']
    const data = request.body

    if (!id || !password) {
        return reply.code(400).send({ error: 'Missing ID or Password header' })
    }

    // Check existing
    const checkStmt = db.prepare('SELECT password FROM kv_store WHERE key = ?')
    const existing = checkStmt.get(id)

    if (existing) {
        // Verify ownership
        if (existing.password !== password) {
            return reply.code(401).send({ error: 'Unauthorized: Password mismatch' })
        }

        // Update
        const updateStmt = db.prepare(`
            UPDATE kv_store 
            SET value = ?, updated_at = ? 
            WHERE key = ?
        `)
        updateStmt.run(JSON.stringify(data), Date.now(), id)
    } else {
        // Claim (New ID)
        const insertStmt = db.prepare(`
            INSERT INTO kv_store (key, value, password, updated_at)
            VALUES (?, ?, ?, ?)
        `)
        insertStmt.run(id, JSON.stringify(data), password, Date.now())
    }

    return { success: true }
})

// SYNC: Delete State (Deletion)
fastify.delete('/api/sync/:id', async (request, reply) => {
    const { id } = request.params
    const password = request.headers['x-sync-password']

    fastify.log.info({ category: 'Server' }, `Received DELETE request for ID: ${id}`)

    if (!id || !password) {
        fastify.log.warn({ category: 'Server' }, `DELETE failed: Missing header for ID ${id}`)
        return reply.code(400).send({ error: 'Missing ID or Password header' })
    }

    const stmt = db.prepare('SELECT password FROM kv_store WHERE key = ?')
    const row = stmt.get(id)

    if (!row) {
        fastify.log.warn({ category: 'Server' }, `DELETE failed: ID ${id} not found`)
        return reply.code(404).send({ error: 'Not found' })
    }

    if (row.password !== password) {
        fastify.log.warn({ category: 'Server' }, `DELETE failed: Password mismatch for ID ${id}`)
        return reply.code(401).send({ error: 'Unauthorized: Invalid Password' })
    }

    fastify.log.info({ category: 'Server' }, `Deleting account data for ID: ${id}`)
    const deleteStmt = db.prepare('DELETE FROM kv_store WHERE key = ?')
    deleteStmt.run(id)

    return { success: true }
})

// PROXY: Manifest Rewriter (Sidekick Mode)
fastify.all('/api/proxy/:token/*', async (request, reply) => {
    const { token } = request.params
    const pathSuffix = request.params['*']

    // We use a dummy URL for the enqueue key since token might be large, 
    // but better to decoode it to get the domain
    let targetDomain = 'unknown'
    try {
        const config = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'))
        targetDomain = new URL(config.url).origin
    } catch (e) { }

    return enqueueProxyRequest(targetDomain, async () => {
        try {
            // 1. Decode Token
            const configStr = Buffer.from(token, 'base64').toString('utf-8')
            const config = JSON.parse(configStr)
            const { url: originalUrl, name: customName, logo: customLogo } = config

            if (!originalUrl) {
                return reply.code(400).send({ error: 'Invalid proxy configuration' })
            }

            // 2. Resolve Target URL
            let targetUrl
            if (pathSuffix === 'manifest.json' || pathSuffix === '') {
                targetUrl = originalUrl
            } else {
                const baseUrl = originalUrl.replace(/\/manifest\.json$/, '').replace(/\/$/, '')
                targetUrl = `${baseUrl}/${pathSuffix}`
            }

            // 3. Fetch
            const response = await fetch(targetUrl, {
                method: request.method,
                headers: {
                    'User-Agent': request.headers['user-agent'] || 'AIOManager-Proxy'
                }
            })

            if (!response.ok) {
                return reply.code(response.status).send(response.statusText)
            }

            // 4. Handle Manifest Modification
            if ((pathSuffix === 'manifest.json' || pathSuffix === '') && (customName || customLogo)) {
                const manifest = await response.json()
                if (customName) manifest.name = customName
                if (customLogo) manifest.logo = customLogo
                manifest.description = (manifest.description || '') + '\n[Proxied by AIOManager]'
                return reply.send(manifest)
            }

            // 5. Pass-through
            const contentType = response.headers.get('content-type')
            if (contentType) reply.type(contentType)
            return reply.send(response.body)

        } catch (err) {
            fastify.log.error({ category: 'Proxy' }, `Fatal Error: ${err.message}`)
            return reply.code(500).send({ error: 'Proxy Error', details: err.message })
        }
    })
})

// --- Autopilot Engine ---
let autopilotInterval = null

const checkAddonHealthInternal = async (url) => {
    try {
        const manifestUrl = url.replace(/\/$/, '') + '/manifest.json'
        const response = await axios.get(manifestUrl, { timeout: 4000 }) // Slightly lower timeout for health checks
        return !!response.data?.id
    } catch (err) {
        return false
    }
}

// Helper to ensure manifests are Stremio-compliant before pushing
const sanitizeManifest = (manifest) => {
    if (!manifest) return { id: '', name: 'Unknown', version: '0.0.0', types: [], resources: [] }
    return {
        ...manifest,
        types: manifest.types || [],
        resources: manifest.resources || []
    }
}

const syncStremioLibrary = async (authKey, chain, activeUrl, accountId) => {
    const STREMIO_API = 'https://api.strem.io/api'

    try {
        // 1. Get current collection
        const getResp = await axios.post(STREMIO_API, {
            type: 'AddonCollectionGet',
            authKey
        })

        if (!getResp.data?.result) throw new Error('Failed to fetch collection')
        let addons = getResp.data.result.addons || []

        // 2. Modify collection based on chain & Sanitize EVERY manifest
        let changed = false
        addons = addons.map(addon => {
            // ALWAYS sanitize manifest to ensure compliance for the entire collection (Raven fix)
            const sanitizedAddon = {
                ...addon,
                manifest: sanitizeManifest(addon.manifest)
            }

            const isTargetInChain = chain.includes(addon.transportUrl)
            if (!isTargetInChain) return sanitizedAddon

            const shouldBeEnabled = addon.transportUrl === activeUrl
            const currentlyEnabled = addon.flags?.enabled !== false

            if (shouldBeEnabled !== currentlyEnabled) {
                changed = true
                sanitizedAddon.flags = { ...addon.flags, enabled: shouldBeEnabled }
            }
            return sanitizedAddon
        })

        // 3. Push if changed or if we need to force a sanitization run
        if (changed) {
            await axios.post(STREMIO_API, {
                type: 'AddonCollectionSet',
                authKey,
                addons
            })
            fastify.log.info({ category: 'Autopilot' }, `[${accountId}] Library synced to Stremio. Active: ${activeUrl}`)
        }
    } catch (err) {
        throw new Error(`Stremio Sync Failed: ${err.message}`)
    }
}

const processAutopilotRule = async (rule) => {
    const chain = JSON.parse(rule.priority_chain)
    const stabilization = JSON.parse(rule.stabilization || '{}')
    const primaryUrl = chain[0] // The intended primary URL

    let currentActiveUrl = rule.active_url || primaryUrl // Use primary if not set

    // Check the current active URL
    const isOk = await checkAddonHealthInternal(currentActiveUrl)

    if (isOk) {
        const newCount = (stabilization[currentActiveUrl] || 0) + 1
        const isFullyRecovered = newCount >= 2 // Promoted on 2nd stable check

        if (isFullyRecovered && currentActiveUrl !== primaryUrl) {
            fastify.log.info({ category: 'Sync' }, `[Autopilot] [${rule.account_id}] Recovery Detected: Promoting ${primaryUrl} back to primary.`)
            currentActiveUrl = primaryUrl
        }
        stabilization[currentActiveUrl] = newCount
    } else {
        // Failure branch: Failover to next in chain
        const currentIndex = chain.indexOf(currentActiveUrl)
        const nextUrl = chain[currentIndex + 1]

        if (nextUrl) {
            fastify.log.warn({ category: 'Sync' }, `[Autopilot] [${rule.account_id}] Handover Triggered: ${currentActiveUrl} is down. Falling back to ${nextUrl}.`)
            currentActiveUrl = nextUrl
        } else {
            fastify.log.error({ category: 'Sync' }, `[Autopilot] [${rule.account_id}] CRITICAL: All addons in chain are down for rule ${rule.id}.`)
            // If all are down, we might still want to try the primary next time, or keep the last known.
            // For now, we'll keep the last known (which is currentActiveUrl, but it's down).
            // A more robust solution might cycle back to primary after a full cycle.
        }
        // Reset stabilization for the failed URL
        stabilization[currentActiveUrl] = 0
    }

    // If the active URL changed, or if it's the first run and active_url was null
    if (currentActiveUrl !== rule.active_url || !rule.active_url) {
        await syncStremioLibrary(rule.auth_key, chain, currentActiveUrl, rule.account_id)
        db.prepare('UPDATE autopilot_rules SET active_url = ?, stabilization = ?, last_check = ?, updated_at = ? WHERE id = ?')
            .run(currentActiveUrl, JSON.stringify(stabilization), Date.now(), Date.now(), rule.id)
    } else {
        // Only update stabilization and check time if active_url didn't change
        db.prepare('UPDATE autopilot_rules SET stabilization = ?, last_check = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(stabilization), Date.now(), Date.now(), rule.id)
    }
}

const runAutopilot = async () => {
    const rules = db.prepare('SELECT * FROM autopilot_rules WHERE is_active = 1').all()

    if (rules.length > 0) {
        fastify.log.info({ category: 'Autopilot' }, `Check Summary: Periodic health check for ${rules.length} active rules.`)
    }

    for (const rule of rules) {
        await processAutopilotRule(rule).catch(err => {
            fastify.log.error({ category: 'Autopilot' }, `Rule ${rule.id} error: ${err.message}`)
        })
    }
}

const startAutopilotWorker = () => {
    if (autopilotInterval) return
    fastify.log.info({ category: 'Autopilot' }, 'Autonomous Engine started. 🚀')

    // Start worker immediately
    runAutopilot().catch(err => fastify.log.error({ category: 'Autopilot' }, `Startup Error: ${err.message}`))

    // Check every 60 seconds (Increased from 5 minutes)
    autopilotInterval = setInterval(() => {
        runAutopilot().catch(err => fastify.log.error({ category: 'Autopilot' }, `Worker Error: ${err.message}`))
    }, 60 * 1000)
}

// --- End ---
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
  One manager to rule them all. Local-first, Encrypted, Powerful. v1.5.0
 ==============================================================================
`;
        console.log(banner);

        // --- Autopilot Sync Endpoint ---
        fastify.post('/api/autopilot/sync', async (request, reply) => {
            const { id, accountId, authKey, priorityChain, activeUrl, isActive } = request.body

            if (!id || !accountId || !authKey || !priorityChain) {
                return reply.status(400).send({ error: 'Missing required Autopilot data' })
            }

            const now = Date.now()
            const stmt = db.prepare(`
            INSERT INTO autopilot_rules (id, account_id, auth_key, priority_chain, active_url, is_active, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                auth_key = excluded.auth_key,
                priority_chain = excluded.priority_chain,
                active_url = excluded.active_url,
                is_active = excluded.is_active,
                updated_at = excluded.updated_at
        `)

            stmt.run(id, accountId, authKey, JSON.stringify(priorityChain), activeUrl, isActive ? 1 : 0, now)

            fastify.log.info({ category: 'Autopilot' }, `[${accountId}] Rule synced to server.`)
            return { success: true }
        })

        fastify.delete('/api/autopilot/:id', async (request, reply) => {
            const { id } = request.params
            db.prepare('DELETE FROM autopilot_rules WHERE id = ?').run(id)
            return { success: true }
        })

        await fastify.listen({ port: PORT, host: '0.0.0.0' })
        fastify.log.info({ category: 'Server' }, `Listening on port ${PORT}`)
        fastify.log.info({ category: 'Database' }, `Path: ${dbPath}`)
        fastify.log.info({ category: 'Security' }, 'Zero-Knowledge mode active. 🛡️')


        // --- Start Autopilot Worker ---
        startAutopilotWorker()
    } catch (err) {
        fastify.log.error(err)
        process.exit(1)
    }
}

// --- Graceful Shutdown ---
const shutdown = async (signal) => {
    console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`)

    try {
        // 1. Close Fastify Server (stops accepting new requests)
        await fastify.close()
        fastify.log.info({ category: 'Server' }, 'Fastify closed.')

        // 2. Flush and Close Database
        if (db) {
            fastify.log.info({ category: 'Database' }, 'Flushing WAL and closing...')
            // Force a full checkpoint to merge WAL into main DB file
            db.pragma('wal_checkpoint(TRUNCATE)')
            db.close()
            fastify.log.info({ category: 'Database' }, 'SQLite connection closed cleanly. 🛡️')
        }

        process.exit(0)
    } catch (err) {
        fastify.log.error({ category: 'Server' }, `Error during shutdown: ${err.message}`)
        process.exit(1)
    }
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

start()
