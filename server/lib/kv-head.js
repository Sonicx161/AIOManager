import db from '../db.js'

const KV_HEAD_INDEX = 'idx_kv_store_head'
let indexed = false

// SQLite reaches a column by walking every column stored before it, so the small kv_store
// columns behind the workspace blob cost a pass over the whole blob; this index holds them alone.
export async function ensureKvHeadIndex(log) {
    if (db.type !== 'sqlite') return false
    try {
        await db.run(`CREATE INDEX IF NOT EXISTS ${KV_HEAD_INDEX} ON kv_store (key, password, content_hash, content_hint, updated_at, credential_epoch)`)
    } catch (err) {
        log?.warn?.({ category: 'Database' }, `Migration step failed: ${err.message}`)
    }
    return detectKvHeadIndex()
}

export async function detectKvHeadIndex() {
    indexed = false
    if (db.type !== 'sqlite') return false
    try {
        indexed = !!(await db.get(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = $1`, [KV_HEAD_INDEX]))
    } catch {
        indexed = false
    }
    return indexed
}

export const kvHeadIndexed = () => indexed

export const kvHeadSource = () => (indexed ? `kv_store INDEXED BY ${KV_HEAD_INDEX}` : 'kv_store')
