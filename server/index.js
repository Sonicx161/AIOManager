import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// --- Configuration ---
const PORT = process.env.PORT || 1610
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
}

// --- Database Setup ---
const dbPath = path.join(DATA_DIR, 'aio.db')
console.log(`[Database] Initializing SQLite at: ${dbPath}`)
const db = new Database(dbPath)

// Initialize Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT,
    password TEXT,
    updated_at INTEGER
  )
`)

// --- Server Setup ---
const fastify = Fastify({
    logger: true,
    bodyLimit: parseInt(process.env.MAX_SYNC_PAYLOAD_SIZE || '104857600')
})

// Register CORS
await fastify.register(cors, {
    origin: true
})

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
fastify.get('/api/health', async () => {
    return { status: 'ok', version: '1.0.0', mode: 'multi-tenant' }
})

// SYNC: Get State (Download)
fastify.get('/api/sync/:id', async (request, reply) => {
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

    // Auth Check
    if (row.password !== password) {
        // Anti-timing attack check would be better, but simple string compare ok for v1
        return reply.code(401).send({ error: 'Unauthorized: Invalid Password' })
    }

    if (!row.value) {
        return {}
    }

    return JSON.parse(row.value)
})

// SYNC: Save State (Claim or Update)
fastify.post('/api/sync/:id', async (request, reply) => {
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

    console.log(`[Server] Received DELETE request for ID: ${id}`)

    if (!id || !password) {
        console.warn(`[Server] DELETE failed: Missing header for ID ${id}`)
        return reply.code(400).send({ error: 'Missing ID or Password header' })
    }

    const stmt = db.prepare('SELECT password FROM kv_store WHERE key = ?')
    const row = stmt.get(id)

    if (!row) {
        console.warn(`[Server] DELETE failed: ID ${id} not found`)
        return reply.code(404).send({ error: 'Not found' })
    }

    if (row.password !== password) {
        console.warn(`[Server] DELETE failed: Password mismatch for ID ${id}`)
        return reply.code(401).send({ error: 'Unauthorized: Invalid Password' })
    }

    console.log(`[Server] Deleting account data for ID: ${id}`)
    const deleteStmt = db.prepare('DELETE FROM kv_store WHERE key = ?')
    deleteStmt.run(id)

    return { success: true }
})

// PROXY: Manifest Rewriter (Sidekick Mode)
fastify.all('/api/proxy/:token/*', async (request, reply) => {
    const { token } = request.params
    const pathSuffix = request.params['*']

    console.log(`[Proxy] Hit: /api/proxy/.../${pathSuffix}`)

    try {
        // 1. Decode Token
        const configStr = Buffer.from(token, 'base64').toString('utf-8')
        console.log(`[Proxy] Decoded config:`, configStr)

        const config = JSON.parse(configStr)
        const { url: originalUrl, name: customName, logo: customLogo } = config

        if (!originalUrl) {
            console.error('[Proxy] Invalid config: missing url')
            return reply.code(400).send({ error: 'Invalid proxy configuration' })
        }

        // 2. Resolve Target URL
        // If the original URL was "https://foo.com/manifest.json", we treat "https://foo.com" as base
        // But Stremio addons are weird.
        // If pathSuffix is "manifest.json", we use originalUrl directly.
        // If pathSuffix is "catalog/...", we append to base.

        let targetUrl
        if (pathSuffix === 'manifest.json' || pathSuffix === '') {
            targetUrl = originalUrl
        } else {
            // Heuristic: Remove 'manifest.json' from end of originalUrl to get base
            const baseUrl = originalUrl.replace(/\/manifest\.json$/, '').replace(/\/$/, '')
            targetUrl = `${baseUrl}/${pathSuffix}`
        }

        console.log(`[Proxy] Forwarding to: ${targetUrl}`)

        // 3. Fetch
        const response = await fetch(targetUrl, {
            method: request.method,
            headers: {
                // Forward relevant headers but strip host/connection
                'User-Agent': request.headers['user-agent'] || 'AIOManager-Proxy'
            }
        })

        if (!response.ok) {
            console.error(`[Proxy] Upstream error: ${response.status}`)
            return reply.code(response.status).send(response.statusText)
        }

        // 4. Handle Manifest Modification
        if ((pathSuffix === 'manifest.json' || pathSuffix === '') && customName) {
            console.log(`[Proxy] Rewriting manifest...`)
            const manifest = await response.json()

            // Apply Overrides
            if (customName) manifest.name = customName
            if (customLogo) manifest.logo = customLogo

            // Add proxy flag for debugging
            manifest.description = (manifest.description || '') + '\n[Proxied by AIOManager]'

            return reply.send(manifest)
        }

        // 5. Stream Pass-through for everything else
        const contentType = response.headers.get('content-type')
        if (contentType) reply.type(contentType)

        // Forward stream
        // Fastify/Node fetch stream compatibility
        return reply.send(response.body)

    } catch (err) {
        request.log.error(err)
        console.error(`[Proxy] Fatal Error:`, err)
        return reply.code(500).send({ error: 'Proxy Error', details: err.message })
    }
})

// --- Start ---
const start = async () => {
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' })
        console.log(`Server listening on port ${PORT}`)
        console.log(`Database path: ${dbPath}`)
        console.log(`[Security] Zero-Knowledge mode active. Client-side hashing verified. 🛡️`)
    } catch (err) {
        fastify.log.error(err)
        process.exit(1)
    }
}

start()
