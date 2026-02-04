import Database from 'better-sqlite3'
import pg from 'pg'
const { Pool, types } = pg

// Force BIGINT (INT8) to be returned as numbers instead of strings
types.setTypeParser(types.builtins.INT8, (val) => parseInt(val, 10))

class DB {
    constructor() {
        this.type = process.env.DB_TYPE || 'sqlite'
        this.client = null
        this.pool = null
        this.isHealthy = false
    }

    /**
     * Initialize database connection with retry logic for HA deployments.
     * Retries up to 5 times with exponential backoff (1s, 2s, 4s, 8s, 16s).
     */
    async init() {
        if (this.type === 'postgres') {
            if (this.pool) return // Already initialized

            console.log('[Database] Connecting to PostgreSQL...')
            const connectionString = process.env.DATABASE_URL
            if (!connectionString) {
                throw new Error('[Database] DATABASE_URL is missing in .env but DB_TYPE is set to postgres')
            }

            // Detect if connecting to a local/Docker PostgreSQL (no SSL needed)
            const isLocalDb = connectionString.includes('localhost') ||
                connectionString.includes('127.0.0.1') ||
                connectionString.includes('@db:') ||
                connectionString.includes('aiomanager-db')

            this.pool = new Pool({
                connectionString,
                ssl: isLocalDb ? false : { rejectUnauthorized: false }, // SSL for cloud providers only
                max: parseInt(process.env.DB_POOL_SIZE, 10) || 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT, 10) || 10000,
            })

            // Handle pool errors to prevent crashes (important for HA)
            this.pool.on('error', (err) => {
                console.error('[Database] Unexpected pool error:', err.message)
                this.isHealthy = false
            })

            // Retry connection with exponential backoff
            const maxRetries = parseInt(process.env.DB_MAX_RETRIES, 10) || 5
            let lastError = null

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const client = await this.pool.connect()
                    client.release()
                    this.isHealthy = true
                    console.log('[Database] Connected to PostgreSQL.')
                    return
                } catch (err) {
                    lastError = err
                    const delay = Math.pow(2, attempt - 1) * 1000 // 1s, 2s, 4s, 8s, 16s
                    console.warn(`[Database] Connection attempt ${attempt}/${maxRetries} failed: ${err.message}`)
                    if (attempt < maxRetries) {
                        console.log(`[Database] Retrying in ${delay / 1000}s...`)
                        await new Promise(resolve => setTimeout(resolve, delay))
                    }
                }
            }

            throw new Error(`[Database] Failed to connect after ${maxRetries} attempts: ${lastError?.message}`)
        } else {
            console.log('[Database] Using SQLite.')
            const dbPath = process.env.SQLITE_DB_PATH || 'data/aio.db'
            this.client = new Database(dbPath)
            this.isHealthy = true
        }
    }

    /**
     * Health check for load balancers and orchestrators.
     * Returns true if DB is connected and responsive.
     */
    async healthCheck() {
        try {
            if (this.type === 'postgres') {
                if (!this.pool) return false
                const client = await this.pool.connect()
                await client.query('SELECT 1')
                client.release()
                this.isHealthy = true
                return true
            } else {
                if (!this.client) return false
                this.client.prepare('SELECT 1').get()
                this.isHealthy = true
                return true
            }
        } catch (err) {
            console.error('[Database] Health check failed:', err.message)
            this.isHealthy = false
            return false
        }
    }

    async query(sql, params = []) {
        if (this.type === 'postgres') {
            const res = await this.pool.query(sql, params)
            return res.rows
        } else {
            const sqliteSql = sql.replace(/\$\d+/g, '?')
            return this.client.prepare(sqliteSql).all(params)
        }
    }

    async get(sql, params = []) {
        if (this.type === 'postgres') {
            const res = await this.pool.query(sql, params)
            return res.rows[0]
        } else {
            const sqliteSql = sql.replace(/\$\d+/g, '?')
            return this.client.prepare(sqliteSql).get(params)
        }
    }

    async run(sql, params = []) {
        if (this.type === 'postgres') {
            const res = await this.pool.query(sql, params)
            return { changes: res.rowCount }
        } else {
            const sqliteSql = sql.replace(/\$\d+/g, '?')
            const info = this.client.prepare(sqliteSql).run(params)
            return { changes: info.changes }
        }
    }

    async exec(sql) {
        if (this.type === 'postgres') {
            // node-postgres handles multi-statement queries in a single string 
            // but it returns an array of results. We just need it to execute.
            await this.pool.query(sql)
        } else {
            this.client.exec(sql)
        }
    }

    async pragma(sql) {
        if (this.type === 'sqlite') {
            return this.client.pragma(sql)
        }
        // PostgreSQL doesn't use pragmas, ignore or map if needed
        return null
    }

    async close() {
        if (this.type === 'postgres') {
            if (this.pool) {
                await this.pool.end()
                this.pool = null
            }
        } else {
            if (this.client) {
                this.client.close()
                this.client = null
            }
        }
        this.isHealthy = false
    }
}

const db = new DB()
export default db
