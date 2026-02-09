import Fastify from 'fastify'
import pinoPretty from 'pino-pretty'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import fastifyCompress from '@fastify/compress'
import axios from 'axios'
import db from './db.js'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { encrypt, decrypt, generateRandomKey } from './crypto.js'

let PRIMARY_KEY = process.env.ENCRYPTION_KEY
let FALLBACK_KEYS = []
if (PRIMARY_KEY) FALLBACK_KEYS.push(PRIMARY_KEY)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// --- Configuration ---
const VERSION = '1.6.1'
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

// --- Zero-Config Encryption Key Management ---
const SECRET_FILE = path.join(DATA_DIR, 'server_secret.key')
if (!PRIMARY_KEY) {
    if (fs.existsSync(SECRET_FILE)) {
        PRIMARY_KEY = fs.readFileSync(SECRET_FILE, 'utf8').trim()
        FALLBACK_KEYS = [PRIMARY_KEY]
        fastify.log.info({ category: 'Security' }, 'Loaded persistent encryption key from data directory.')
    } else {
        PRIMARY_KEY = generateRandomKey()
        fs.writeFileSync(SECRET_FILE, PRIMARY_KEY, 'utf8')
        FALLBACK_KEYS = [PRIMARY_KEY]
        fastify.log.info({ category: 'Security' }, 'No ENCRYPTION_KEY found. Generated a new random key and saved it to data directory.')
    }
} else {
    fastify.log.info({ category: 'Security' }, 'Using ENCRYPTION_KEY from environment.')
    // Add the data-dir key to fallback if it exists and is different
    if (fs.existsSync(SECRET_FILE)) {
        const fileKey = fs.readFileSync(SECRET_FILE, 'utf8').trim()
        if (fileKey !== PRIMARY_KEY) {
            FALLBACK_KEYS.push(fileKey)
            fastify.log.warn({ category: 'Security' }, 'Detected encryption key mismatch between .env and data directory. Added old key to fallback list.')
        }
    }
}

// --- Custom HTML Injection Log ---
if (process.env.CUSTOM_HTML) {
    fastify.log.info({ category: 'Server' }, 'Custom HTML injection active.')
}

// --- Database Setup ---
const dbPath = path.join(DATA_DIR, 'aio.db')
if (db.type === 'sqlite') {
    fastify.log.info({ category: 'Database' }, `Initializing SQLite at: ${dbPath}`)
    process.env.SQLITE_DB_PATH = dbPath
} else {
    fastify.log.info({ category: 'Database' }, 'Initializing PostgreSQL...')
}
await db.init()

if (db.type === 'sqlite') {
    // SQLite Performance & Stability Optimizations
    await db.pragma('journal_mode = WAL')
    await db.pragma('synchronous = NORMAL')
    await db.pragma('temp_store = MEMORY')
    await db.pragma('cache_size = -2000') // 2MB cache
    await db.pragma('auto_vacuum = INCREMENTAL') // Keeps file small over time

    // Run a manual vacuum on startup to clean up bloat if needed
    fastify.log.info({ category: 'Database' }, 'Running startup maintenance (VACUUM)...')
    await db.exec('VACUUM')
}

// Initialize Schema
const schema = `
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT,
    password TEXT,
    updated_at BIGINT
  );

  CREATE TABLE IF NOT EXISTS autopilot_rules (
    id TEXT PRIMARY KEY,
    account_id TEXT,
    auth_key TEXT,
    priority_chain TEXT,
    addon_list TEXT,
    active_url TEXT,
    stabilization TEXT,
    is_active INTEGER DEFAULT 1,
    is_automatic INTEGER DEFAULT 1,
    last_check BIGINT,
    updated_at BIGINT
  );
`

// Execute schema creation
// PostgreSQL requires splitting multi-statement strings if using client.query sometimes,
// but db.exec should handle it.
await db.exec(schema)

// Migration: Add addon_list column if it doesn't exist (for existing databases)
try {
    if (db.type === 'postgres') {
        // Migration: Ensure columns are TEXT/VARCHAR for encrypted strings, not JSONB
        await db.run(`ALTER TABLE autopilot_rules ALTER COLUMN priority_chain TYPE TEXT`)
        await db.run(`ALTER TABLE autopilot_rules ALTER COLUMN addon_list TYPE TEXT`)
        await db.run(`ALTER TABLE autopilot_rules ALTER COLUMN stabilization TYPE TEXT`)
        fastify.log.info({ category: 'Database' }, 'Postgres Migration: Converted JSONB categories to TEXT for encryption support.')
    } else {
        // SQLite doesn't have IF NOT EXISTS for columns, so we check first
        const tableInfo = await db.query(`PRAGMA table_info(autopilot_rules)`)
        const hasAddonList = tableInfo.some(col => col.name === 'addon_list')
        if (!hasAddonList) {
            await db.run(`ALTER TABLE autopilot_rules ADD COLUMN addon_list TEXT`)
            fastify.log.info({ category: 'Database' }, 'Migrated: Added addon_list column to autopilot_rules')
        }
        const hasIsAutomatic = tableInfo.some(col => col.name === 'is_automatic')
        if (!hasIsAutomatic) {
            await db.run(`ALTER TABLE autopilot_rules ADD COLUMN is_automatic INTEGER DEFAULT 1`)
            fastify.log.info({ category: 'Database' }, 'Migrated: Added is_automatic column to autopilot_rules')
        }
    }
    if (db.type === 'postgres') {
        // Postgres Specific Migration for is_automatic column
        try {
            await db.run(`ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS is_automatic INTEGER DEFAULT 1`)
        } catch (e) {
            // IF NOT EXISTS might not be supported on very old postgres, but generally it is.
        }
    }
} catch (migrationErr) {
    fastify.log.warn({ category: 'Database' }, `Migration warning: ${migrationErr.message}`)
}

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

// Health Check (For Load Balancers / Kubernetes / HA setups)
fastify.get('/api/health', {
    schema: {
        response: {
            200: {
                type: 'object',
                properties: {
                    status: { type: 'string' },
                    version: { type: 'string' },
                    mode: { type: 'string' },
                    optimized: { type: 'boolean' },
                    database: {
                        type: 'object',
                        properties: {
                            type: { type: 'string' },
                            healthy: { type: 'boolean' }
                        }
                    }
                }
            }
        }
    }
}, async (request, reply) => {
    const dbHealthy = await db.healthCheck()
    const overallStatus = dbHealthy ? 'ok' : 'degraded'

    // Return 503 if DB is down (helps load balancers route away from unhealthy instances)
    if (!dbHealthy) {
        return reply.code(503).send({
            status: 'degraded',
            version: '1.5.9',
            mode: 'multi-tenant',
            optimized: true,
            database: { type: db.type, healthy: false }
        })
    }

    return {
        status: overallStatus,
        version: '1.5.6',
        mode: 'multi-tenant',
        optimized: true,
        database: { type: db.type, healthy: true }
    }
})

// CONFIG: Get public configuration (for frontend customization)
fastify.get('/api/config', async (request, reply) => {
    return {
        customHtml: process.env.CUSTOM_HTML || null
    }
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

    try {
        const row = await db.get('SELECT value, password FROM kv_store WHERE key = $1', [id])

        if (!row) {
            return reply.code(404).send({ error: 'Not found' })
        }

        // 1. Decrypt password for comparison (Silent migration fallback)
        const decryptedPassword = decrypt(row.password, FALLBACK_KEYS)
        if (decryptedPassword !== password) {
            fastify.log.warn({ category: 'Sync' }, `[${id}] Unauthorized: Password mismatch.`)
            return reply.code(401).send({ error: 'Unauthorized: Invalid Password' })
        }

        // 2. Decrypt value for client (Silent migration fallback)
        const decryptedValueStr = decrypt(row.value, FALLBACK_KEYS)

        // 3. Silent Migration Check (Null-safe)
        const needsMigration = (row.password && typeof row.password === 'string' && !row.password.includes(':')) ||
            (row.value && typeof row.value === 'string' && !row.value.includes(':'))

        if (needsMigration) {
            fastify.log.info({ category: 'Sync' }, `[${id}] Upgrading sync data to Zero-Knowledge storage.`)
            const encryptedPass = encrypt(password, PRIMARY_KEY)
            const encryptedVal = encrypt(decryptedValueStr, PRIMARY_KEY)
            await db.run('UPDATE kv_store SET password = $1, value = $2, updated_at = $3 WHERE key = $4',
                [encryptedPass, encryptedVal, Date.now(), id])
        }

        let syncData = {}
        if (decryptedValueStr) {
            try {
                syncData = typeof decryptedValueStr === 'string' ? JSON.parse(decryptedValueStr) : decryptedValueStr
            } catch (e) {
                fastify.log.warn({ category: 'Sync' }, `[${id}] Failed to parse sync data: ${e.message}`)
                syncData = {}
            }
        }
        return reply.send(syncData && typeof syncData === 'object' ? syncData : {})
    } catch (err) {
        fastify.log.error({ category: 'Sync' }, `[${id}] GET Error: ${err.message}`)
        return reply.code(500).send({ error: 'Server error, please try again later.', details: err.message })
    }
})


// SECURITY: SSRF Protection
const isSafeUrl = (url) => {
    try {
        const u = new URL(url)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false

        // Block private/internal ranges
        const hostname = u.hostname
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false
        if (hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.startsWith('172.')) return false

        // Fast-Fail Video Extensions (Anti-Abuse)
        if (u.pathname.match(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i)) return false

        return true
    } catch (e) { return false }
}

// PROXY: Simple Metadata/Manifest Proxy (Secured)
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

    if (!isSafeUrl(url)) {
        fastify.log.warn({ category: 'Security' }, `blocked unsafe proxy request: ${url}`)
        return reply.code(403).send({ error: 'Access Denied: Unsafe URL' })
    }

    return enqueueProxyRequest(url, async () => {
        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 6000) // 6s timeout

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'AIOManager/1.5.10 (Internal Proxy; Hardened)',
                    'Accept': 'application/json, text/plain, */*'
                }
            })

            clearTimeout(timeout)

            if (!response.ok) {
                return reply.code(response.status).send({ error: `Upstream returned ${response.status}` })
            }

            // 1. Content-Type Check (Allow JSON/Text/Web, block Media)
            const contentType = response.headers.get('content-type') || ''
            if (contentType.startsWith('video/') || contentType.startsWith('audio/')) {
                return reply.code(415).send({ error: 'Unsupported Media Type' })
            }
            if (contentType) reply.type(contentType)

            // 2. Size Limit Check (5MB)
            const contentLength = parseInt(response.headers.get('content-length') || '0')
            if (contentLength > 5 * 1024 * 1024) {
                return reply.code(413).send({ error: 'Payload Too Large (>5MB)' })
            }

            // FIX: Fastify/Compress doesn't handle Web ReadableStream well, convert to Buffer
            const arrayBuffer = await response.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)

            // Double-check buffer size just in case content-length was missing/fake
            if (buffer.length > 5 * 1024 * 1024) {
                return reply.code(413).send({ error: 'Payload Too Large (>5MB)' })
            }

            return reply.send(buffer)
        } catch (err) {
            if (err.name === 'AbortError') {
                fastify.log.error({ category: 'MetaProxy' }, `Timeout after 6s: ${url}`)
                return reply.code(504).send({ error: 'Gateway Timeout', details: 'Upstream addon took too long to respond (>6s)' })
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
        // Strict Whitelist: Block unknown methods to prevent abuse
        fastify.log.warn({ category: 'Security' }, `[Proxy] Blocked unauthorized Stremio API call: ${type}`)
        return reply.code(403).send({ error: 'Method Not Allowed' })
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
    const row = await db.get('SELECT password FROM kv_store WHERE key = $1', [id])

    // SERVER-SIDE TIMESTAMPING (Single Source of Truth)
    const serverTime = new Date().toISOString()
    data.syncedAt = serverTime

    const encryptedVal = encrypt(JSON.stringify(data), PRIMARY_KEY)
    const encryptedPass = encrypt(password, PRIMARY_KEY)

    if (row) {
        // Verify ownership (Decrypt legacy or fresh)
        const decryptedPassword = decrypt(row.password, FALLBACK_KEYS)
        if (decryptedPassword !== password) {
            return reply.code(401).send({ error: 'Unauthorized: Password mismatch' })
        }

        // Update (Always Save Encrypted)
        await db.run(`
            UPDATE kv_store 
            SET value = $1, password = $2, updated_at = $3 
            WHERE key = $4
        `, [encryptedVal, encryptedPass, Date.now(), id])
    } else {
        // Claim (Always Save Encrypted)
        await db.run(`
            INSERT INTO kv_store (key, value, password, updated_at)
            VALUES ($1, $2, $3, $4)
        `, [id, encryptedVal, encryptedPass, Date.now()])
    }

    return { success: true, syncedAt: serverTime }
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

    const row = await db.get('SELECT password FROM kv_store WHERE key = $1', [id])

    if (!row) {
        fastify.log.warn({ category: 'Server' }, `DELETE failed: ID ${id} not found`)
        return reply.code(404).send({ error: 'Not found' })
    }

    const decryptedPassword = decrypt(row.password, FALLBACK_KEYS)
    if (decryptedPassword !== password) {
        fastify.log.warn({ category: 'Server' }, `DELETE failed: Password mismatch for ID ${id}`)
        return reply.code(401).send({ error: 'Unauthorized: Invalid Password' })
    }

    fastify.log.info({ category: 'Server' }, `Deleting account data for ID: ${id}`)
    await db.run('DELETE FROM kv_store WHERE key = $1', [id])

    return { success: true }
})

// PROXY: Manifest Rewriter (Sidekick Mode)
fastify.all('/api/proxy/:token/*', async (request, reply) => {
    const { token } = request.params
    const pathSuffix = request.params['*']

    // We use a dummy URL for the enqueue key since token might be large, 
    // but better to decoode it to get the domain
    let targetDomain = 'unknown'
    let originalUrl = ''
    try {
        const config = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'))
        targetDomain = new URL(config.url).origin
        originalUrl = config.url
    } catch (e) {
        fastify.log.warn({ category: 'Proxy' }, `Failed to decode token: ${e.message}`)
        return reply.code(400).send({ error: 'Invalid Token' })
    }

    // SSRF Protection for Manifest Rewriter
    if (!isSafeUrl(originalUrl)) {
        fastify.log.warn({ category: 'Security' }, `blocked unsafe proxy request (Manifest Rewriter): ${originalUrl}`)
        return reply.code(403).send({ error: 'Access Denied: Unsafe URL' })
    }

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
            // FIX: Fastify/Compress doesn't handle Web ReadableStream well, convert to Buffer
            const arrayBuffer = await response.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)
            return reply.send(buffer)

        } catch (err) {
            // PROXY RESILIENCE: If upstream is dead (offline), we MUST return a valid manifest
            // so Stremio doesn't delete the addon or show garbage.
            if ((pathSuffix === 'manifest.json' || pathSuffix === '') && customName) {
                fastify.log.warn({ category: 'Proxy' }, `Upstream offline: ${targetDomain}. Serving fallback manifest for ${customName}.`)
                return reply.send({
                    id: 'proxy-offline-' + Date.now(),
                    name: customName,
                    version: '0.0.1',
                    description: 'This addon is currently offline or unreachable. The Manager is attempting to restore connection.',
                    logo: customLogo,
                    resources: [],
                    types: [],
                    catalogs: []
                })
            }

            fastify.log.error({ category: 'Proxy' }, `Fatal Error: ${err.message}`)
            return reply.code(502).send({ error: 'Proxy Error', details: 'Upstream Unreachable' })
        }
    })
})

// --- Autopilot Engine ---
let autopilotInterval = null

const normalizeAddonUrl = (url) => {
    if (!url) return ''
    let normalized = url.trim()
    // 1. Force protocol consistency
    normalized = normalized.replace(/^stremio:\/\//i, 'https://')
    // 2. Remove manifest.json suffix (case insensitive)
    normalized = normalized.replace(/\/manifest\.json$/i, '')
    // 3. Remove trailing slashes
    normalized = normalized.replace(/\/+$/, '')
    return normalized
}

const checkAddonHealthInternal = async (url) => {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    let domain = url
    try { domain = new URL(url).origin } catch (e) { }

    const performCheck = async (target, timeoutMs) => {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

        try {
            // Priority 1: HEAD request
            const res1 = await fetch(target, {
                method: 'HEAD',
                signal: controller.signal,
                headers: { 'User-Agent': userAgent }
            })
            if (res1.ok || res1.status === 405) {
                clearTimeout(timeoutId)
                return true
            }

            // Priority 2: GET request (if HEAD fails/is blocked)
            const res2 = await fetch(target, {
                method: 'GET',
                signal: controller.signal,
                headers: { 'User-Agent': userAgent }
            })
            clearTimeout(timeoutId)
            return res2.ok
        } catch (err) {
            clearTimeout(timeoutId)
            return false
        }
    }

    // 1. Silent Domain-Only Check (Anti-Flood Path)
    // Most checks stop here, keeping provider logs clean.
    if (await performCheck(domain, 15000)) {
        fastify.log.info({ category: 'Autopilot' }, `[Health] Host ${domain} is online. (Domain-Only)`)
        return true
    }

    // 2. Definitive Manifest Check (Fallback Path)
    // Only hit the manifest if the domain root is unresponsive to avoid false failovers.
    if (await performCheck(url, 15000)) {
        fastify.log.info({ category: 'Autopilot' }, `[Health] Host ${domain} online via manifest fallback.`)
        return true
    }

    fastify.log.warn({ category: 'Autopilot' }, `[Health] Host ${domain} is fully unreachable.`)
    return false
}

const deriveAddonName = (url) => {
    try {
        const hostname = new URL(url).hostname
        return hostname
            .replace(/^www\./, '')
            .replace(/\.[^.]+$/, '')
            .split(/[.-]/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ')
    } catch {
        return 'Unknown Addon'
    }
}

// Helper to ensure manifests are Stremio-compliant before pushing
const sanitizeManifest = (manifest, transportUrl = '') => {
    const isUnknown = !manifest?.name || manifest?.name === 'Unknown Addon' || manifest?.name === 'Restoring Addon...'
    const name = isUnknown && transportUrl ? deriveAddonName(transportUrl) : (manifest?.name || 'Unknown Addon')

    return {
        ...manifest,
        name,
        id: manifest?.id || `synth-${Date.now()}`,
        version: manifest?.version || '0.0.0',
        types: manifest?.types || [],
        resources: manifest?.resources || []
    }
}

// Helper: Merge remote addons with local addons (Mirror of frontend accountStore.ts)
const mergeAddons = (localAddons, remoteAddons) => {
    const remoteAddonMap = new Map((remoteAddons || []).map(a => [normalizeAddonUrl(a.transportUrl).toLowerCase(), a]));
    const processedRemoteNormUrls = new Set();
    const finalAddons = [];

    // ANTI-WIPE GUARD: Favor local manifest if remote is 'broken' or 'ghost'.
    const isSubstantial = (m) => {
        if (!m || !m.name || m.name === 'Unknown Addon') return false;
        const v = (m.version || '').replace(/^v/, '');
        const hasResources = Array.isArray(m.resources) && m.resources.length > 0;
        return v !== '0.0.0' && v !== '' && hasResources;
    };

    // 1. Mirror Local List (Source of Truth for Order & Failover Flags)
    (localAddons || []).forEach(localAddon => {
        const normLocal = normalizeAddonUrl(localAddon.transportUrl).toLowerCase()
        const remoteAddon = remoteAddonMap.get(normLocal);

        if (remoteAddon) {
            const remoteManifest = remoteAddon.manifest;
            const localManifest = localAddon.manifest;
            const useLocalManifest = isSubstantial(localManifest) && !isSubstantial(remoteManifest);

            finalAddons.push({
                ...remoteAddon,
                manifest: useLocalManifest ? localManifest : remoteManifest,
                flags: {
                    ...(remoteAddon.flags || {}),
                    protected: localAddon.flags?.protected,
                    enabled: localAddon.flags?.enabled ?? true
                },
                metadata: localAddon.metadata
            });
            processedRemoteNormUrls.add(normLocal);
        } else {
            // Missing from Remote: Still important for recovery or preservation
            // We include it here; prepareAddonsForStremio will filter it out if enabled is false.
            finalAddons.push(localAddon);
        }
    });

    // 2. Append any mystery remote addons
    (remoteAddons || []).forEach(remoteAddon => {
        const normRemote = normalizeAddonUrl(remoteAddon.transportUrl).toLowerCase()
        if (!processedRemoteNormUrls.has(normRemote)) {
            finalAddons.push(remoteAddon);
        }
    });

    return finalAddons
}

// Helper: Apply manifest customizations (Mirror of frontend api/addons.ts - Raven fix)
const prepareAddonsForStremio = (addons) => {
    return (addons || [])
        .filter(addon => addon.flags?.enabled !== false)
        .map(addon => {
            const baseManifest = sanitizeManifest(addon.manifest, addon.transportUrl)
            const meta = addon.metadata || {}

            if (meta.customName || meta.customDescription || meta.customLogo) {
                return {
                    ...addon,
                    manifest: {
                        ...baseManifest,
                        name: meta.customName || baseManifest.name || '',
                        logo: meta.customLogo || baseManifest.logo || undefined,
                        description: meta.customDescription || baseManifest.description || '',
                    }
                }
            }
            return { ...addon, manifest: baseManifest }
        })
}

/**
 * Sync to Stremio (Manager-Mirror Mode).
 * Behaves exactly like the Manager's toggle buttons.
 */
const syncStremioLive = async (authKey, chain, activeUrl, accountId, storedAddonList = []) => {
    const STREMIO_API = 'https://api.strem.io/api'

    try {
        // 1. Fetch live collection
        const getRes = await axios.post(`${STREMIO_API}/addonCollectionGet`, {
            type: 'AddonCollectionGet',
            authKey
        })

        const remoteAddons = getRes.data?.result?.addons || [];

        // 2. Prepare the target state
        const normalizedChain = chain.map(u => normalizeAddonUrl(u).toLowerCase());
        const normalizedActive = normalizeAddonUrl(activeUrl).toLowerCase();

        // 2. Prepare the target state
        // CRITICAL FIX: Use the storedMasterList as the primary baseline for order.
        // This ensures that enabled backups don't jump to the end of the Stremio list.
        const baseAddonList = (storedAddonList && storedAddonList.length > 0)
            ? [...storedAddonList]
            : [...remoteAddons];

        // Ensure all chain addons are in baseAddonList
        normalizedChain.forEach((normUrl, idx) => {
            const exists = baseAddonList.some(a => normalizeAddonUrl(a.transportUrl).toLowerCase() === normUrl);
            if (!exists) {
                // Try to find it in remote first
                const remote = remoteAddons.find(a => normalizeAddonUrl(a.transportUrl).toLowerCase() === normUrl);

                // CRITICAL FIX: Scavenge from the stored account addons if missing from remote
                // Only scavenge if the stored manifest is substantial
                const isSubstantial = (m) => m && m.name && m.name !== 'Unknown Addon' && m.name !== 'Restoring Addon...' && Array.isArray(m.resources) && m.resources.length > 0;
                const stored = (storedAddonList || []).find(a => normalizeAddonUrl(a.transportUrl).toLowerCase() === normUrl);

                if (remote) {
                    baseAddonList.push(remote);
                } else if (stored && isSubstantial(stored.manifest)) {
                    // Use the rich stored manifest
                    baseAddonList.push({
                        ...stored,
                        flags: { ...(stored.flags || {}), enabled: false }
                    });
                } else {
                    // Disaster Recovery: Add a placeholder
                    baseAddonList.push({
                        transportUrl: chain[idx],
                        manifest: { id: `synth-${idx}`, name: 'Restoring Addon...', version: '0.0.0', types: [], resources: [] },
                        flags: { enabled: false }
                    });
                }
            }
        });

        const updatedLocalAddons = baseAddonList.map(addon => {
            const normalizedUrl = normalizeAddonUrl(addon.transportUrl).toLowerCase()
            if (normalizedChain.includes(normalizedUrl)) {
                const isTarget = normalizedUrl === normalizedActive
                return {
                    ...addon,
                    flags: { ...(addon.flags || {}), enabled: isTarget }
                }
            }
            return addon
        })

        // 3. Merge and finalize
        const mergedAddons = mergeAddons(updatedLocalAddons, remoteAddons)
        const finalAddons = prepareAddonsForStremio(mergedAddons)

        if (finalAddons.length === 0 && remoteAddons.length > 0) {
            throw new Error('Sync produced an empty list, aborting to prevent wiping Stremio collection.')
        }

        // 4. Push back
        await axios.post(`${STREMIO_API}/addonCollectionSet`, {
            type: 'AddonCollectionSet',
            authKey,
            addons: finalAddons
        })
        fastify.log.info({ category: 'Autopilot' }, `[${accountId}] Stremio updated (Mirror): ${finalAddons.length} addons actively installed.`)
    } catch (err) {
        if (err.response?.status === 401) {
            fastify.log.error({ category: 'Autopilot' }, `[${accountId}] Auth Key Expired (401). Disabling rule.`)
            await db.run('UPDATE autopilot_rules SET is_active = 0 WHERE account_id = $1', [accountId])
        }
        fastify.log.error({ category: 'Autopilot' }, `[${accountId}] Mirror sync failed: ${err.message}`)
        throw err
    }
}

// Autopilot configuration
// We removed stabilization thresholds (pts system) as per user request for simplicity.
// Switching is now immediate based on health checks.


const processAutopilotRule = async (rule) => {
    if (rule.is_automatic === 0) {
        // Skip automatic switching for manual-only rules
        return
    }
    // 1. Decrypt and Parse Data
    const decryptedAuthKey = decrypt(rule.auth_key, FALLBACK_KEYS)
    const decryptedChainStr = decrypt(rule.priority_chain, FALLBACK_KEYS)
    const decryptedActiveUrl = decrypt(rule.active_url, FALLBACK_KEYS) || rule.active_url
    const decryptedStabilizationStr = rule.stabilization ? decrypt(rule.stabilization, FALLBACK_KEYS) : null
    const decryptedAddonListStr = rule.addon_list ? decrypt(rule.addon_list, FALLBACK_KEYS) : null

    let chain = []
    try {
        if (Array.isArray(decryptedChainStr)) {
            chain = decryptedChainStr
        } else if (typeof decryptedChainStr === 'string' && decryptedChainStr.startsWith('[')) {
            chain = JSON.parse(decryptedChainStr)
        } else if (typeof rule.priority_chain === 'string' && rule.priority_chain.startsWith('[')) {
            chain = JSON.parse(rule.priority_chain)
        }
    } catch (e) {
        fastify.log.warn({ category: 'Autopilot' }, `[${rule.account_id}] Chain parse failed: ${e.message}`)
    }

    if (!Array.isArray(chain) || chain.length === 0) {
        fastify.log.error({ category: 'Autopilot' }, `[${rule.account_id}] No valid priority chain. Skipping.`)
        return
    }

    let addonList = [];
    try {
        if (Array.isArray(decryptedAddonListStr)) {
            addonList = decryptedAddonListStr
        } else if (typeof decryptedAddonListStr === 'string' && decryptedAddonListStr.startsWith('[')) {
            addonList = JSON.parse(decryptedAddonListStr)
        } else if (typeof rule.addon_list === 'string' && rule.addon_list.startsWith('[')) {
            addonList = JSON.parse(rule.addon_list)
        }
    } catch (e) {
        fastify.log.warn({ category: 'Autopilot' }, `[${rule.account_id}] Addon list parse failed: ${e.message}`)
    }

    let stabilization = {}
    try {
        if (decryptedStabilizationStr && typeof decryptedStabilizationStr === 'object') {
            stabilization = decryptedStabilizationStr
        } else if (typeof decryptedStabilizationStr === 'string' && decryptedStabilizationStr.startsWith('{')) {
            stabilization = JSON.parse(decryptedStabilizationStr)
        } else if (typeof rule.stabilization === 'string' && rule.stabilization.startsWith('{')) {
            stabilization = JSON.parse(rule.stabilization)
        }
    } catch (e) {
        stabilization = {}
    }

    // 2. Health Sweep & Target Selection
    let targetActiveUrl = chain[0] // Default to primary
    let foundOnline = false
    for (const url of chain) {
        const isHealthy = await checkAddonHealthInternal(url)
        if (isHealthy) {
            targetActiveUrl = url
            foundOnline = true
            break
        }
    }

    // 3. Detect Changes
    const decryptedNormalizedActive = normalizeAddonUrl(decryptedActiveUrl || chain[0]).toLowerCase()
    // 4. Synchronization Logic
    const normalizedTarget = normalizeAddonUrl(targetActiveUrl).toLowerCase()
    const normalizedChain = chain.map(u => normalizeAddonUrl(u).toLowerCase())

    // Update local addonList enabled states (One-Hot enforcement)
    // This ensures local state matches what we're about to push to Stremio
    const updatedAddonList = addonList.map(addon => {
        const normUrl = normalizeAddonUrl(addon.transportUrl).toLowerCase()
        if (normalizedChain.includes(normUrl)) {
            return {
                ...addon,
                flags: { ...(addon.flags || {}), enabled: normUrl === normalizedTarget }
            }
        }
        return addon
    })

    // Detect if we shifted priority
    const hasChanged = normalizedTarget !== decryptedNormalizedActive

    if (hasChanged) {
        const statusMsg = foundOnline ? `Swapping to: ${normalizedTarget.substring(0, 40)}` : `Outage! Primary offline, keeping/forcing ${normalizedTarget.substring(0, 40)}`
        fastify.log.info({ category: 'Autopilot' }, `[${rule.account_id}] [Switch] ${statusMsg}`)
    }

    // Live Sync (Fetch -> Filter -> Inject -> Push)
    // We pass our updatedAddonList to syncStremioLive
    try {
        await syncStremioLive(decryptedAuthKey, chain, targetActiveUrl, rule.account_id, updatedAddonList)
        fastify.log.info({ category: 'Autopilot' }, `[${rule.account_id}] Stremio synced: ${normalizedTarget.substring(0, 40)} active.`)
    } catch (syncErr) {
        fastify.log.error({ category: 'Autopilot' }, `[${rule.account_id}] Stremio sync error: ${syncErr.message}`)
    }

    // Save State (Encrypt all fields for uniformity)
    const activeUrlToSave = encrypt(targetActiveUrl, PRIMARY_KEY)
    const authKeyToSave = encrypt(decryptedAuthKey, PRIMARY_KEY)
    const chainToSave = encrypt(JSON.stringify(chain), PRIMARY_KEY)
    const stabilizationToSave = encrypt(JSON.stringify(stabilization), PRIMARY_KEY)
    const addonListToSave = encrypt(JSON.stringify(updatedAddonList), PRIMARY_KEY)

    // 5. Optimization: Only update DB if something meaningful changed (Zero Idle Write)
    if (!hasChanged) {
        // Skip DB write entirely if state is stable.
        return
    }

    await db.run(`
        UPDATE autopilot_rules 
        SET active_url = $1, auth_key = $2, priority_chain = $3, stabilization = $4, addon_list = $5, last_check = $6, updated_at = $7 
        WHERE id = $8 
        AND (
            active_url IS DISTINCT FROM $9 OR 
            priority_chain IS DISTINCT FROM $10 OR 
            stabilization IS DISTINCT FROM $11 OR
            addon_list IS DISTINCT FROM $12
        )
    `, [
        activeUrlToSave, authKeyToSave, chainToSave, stabilizationToSave, addonListToSave, Date.now(), Date.now(), rule.id,
        activeUrlToSave, chainToSave, stabilizationToSave, addonListToSave
    ])
}

const runAutopilot = async () => {
    const rules = await db.query('SELECT id, account_id, auth_key, priority_chain, addon_list, active_url, stabilization, is_automatic FROM autopilot_rules WHERE is_active = 1')

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
  One manager to rule them all. Local-first, Encrypted, Powerful. v1.6.1
 ==============================================================================
`;
        console.log(banner);

        // --- Autopilot Sync Endpoint ---
        fastify.post('/api/autopilot/sync', async (request, reply) => {
            const { id, accountId, authKey, priorityChain, activeUrl, is_active, is_automatic, addonList } = request.body

            if (!id || !accountId || !authKey || !priorityChain) {
                return reply.status(400).send({ error: 'Missing required Autopilot data' })
            }

            // Encrypt sensitive data for storage
            const encryptedAuthKey = encrypt(authKey, PRIMARY_KEY)
            const encryptedChain = encrypt(JSON.stringify(priorityChain), PRIMARY_KEY)
            const encryptedActiveUrl = activeUrl ? encrypt(activeUrl, PRIMARY_KEY) : null
            const encryptedAddonList = addonList ? encrypt(JSON.stringify(addonList), PRIMARY_KEY) : null

            const now = Date.now()
            if (db.type === 'postgres') {
                await db.run(`
                    INSERT INTO autopilot_rules (id, account_id, auth_key, priority_chain, addon_list, active_url, is_active, is_automatic, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (id) DO UPDATE SET
                        auth_key = EXCLUDED.auth_key,
                        priority_chain = EXCLUDED.priority_chain,
                        addon_list = EXCLUDED.addon_list,
                        active_url = EXCLUDED.active_url,
                        is_active = EXCLUDED.is_active,
                        is_automatic = EXCLUDED.is_automatic,
                        updated_at = EXCLUDED.updated_at
                `, [id, accountId, encryptedAuthKey, encryptedChain, encryptedAddonList, encryptedActiveUrl, is_active ? 1 : 0, is_automatic === 0 ? 0 : 1, now])
            } else {
                await db.run(`
                    INSERT INTO autopilot_rules (id, account_id, auth_key, priority_chain, addon_list, active_url, is_active, is_automatic, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT(id) DO UPDATE SET
                        auth_key = excluded.auth_key,
                        priority_chain = excluded.priority_chain,
                        addon_list = excluded.addon_list,
                        active_url = excluded.active_url,
                        is_active = excluded.is_active,
                        is_automatic = excluded.is_automatic,
                        updated_at = excluded.updated_at
                `, [id, accountId, encryptedAuthKey, encryptedChain, encryptedAddonList, encryptedActiveUrl, is_active ? 1 : 0, is_automatic === 0 ? 0 : 1, now])
            }

            fastify.log.info({ category: 'Autopilot' }, `[${accountId}] Rule synced to server (Swap & Hide Mode).`)
            return { success: true }
        })


        // --- Get Autopilot Active States (so frontend can sync with server) ---
        fastify.get('/api/autopilot/state/:accountId', async (request, reply) => {
            const { accountId } = request.params

            const rules = await db.query('SELECT id, active_url, is_active, is_automatic, last_check FROM autopilot_rules WHERE account_id = $1', [accountId])

            // Decrypt active_url for each rule
            const states = (rules || []).map(rule => ({
                id: rule.id,
                activeUrl: rule.active_url ? decrypt(rule.active_url, FALLBACK_KEYS) : null,
                isActive: rule.is_active === 1,
                isAutomatic: rule.is_automatic === 1,
                lastCheck: rule.last_check
            }))

            return { states }
        })

        fastify.delete('/api/autopilot/:id', async (request, reply) => {
            const { id } = request.params
            await db.run('DELETE FROM autopilot_rules WHERE id = $1', [id])
            return { success: true }
        })


        await fastify.listen({ port: PORT, host: '0.0.0.0' })
        fastify.log.info({ category: 'Server' }, `Listening on port ${PORT}`)
        if (db.type === 'sqlite') {
            fastify.log.info({ category: 'Database' }, `Path: ${dbPath}`)
        }
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
            fastify.log.info({ category: 'Database' }, 'Flushing and closing...')
            if (db.type === 'sqlite') {
                // Force a full checkpoint to merge WAL into main DB file
                await db.pragma('wal_checkpoint(TRUNCATE)')
            }
            await db.close()
            fastify.log.info({ category: 'Database' }, 'Database connection closed cleanly. 🛡️')
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
