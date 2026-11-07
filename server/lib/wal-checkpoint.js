// Bounded WAL hygiene for SQLite: each changed sync push archives + rewrites the whole
// multi-MB envelope, and without an explicit checkpoint the -wal file plateaus around
// 20+ MB of disk. Successful sync writes accrue here and run one non-blocking
// wal_checkpoint(PASSIVE) once the byte threshold or the small-write interval elapses,
// off the response path. PASSIVE never waits on readers (unlike TRUNCATE, which can
// stall the Node event loop); when the result row reports busy the pending bytes stay
// accounted and the next write trigger retries. Storage-level only: no row churn, no
// Autopilot writes, and no effect on PostgreSQL.
import db from '../db.js'
import { trace } from '../utils/trace.js'

export const WAL_CHECKPOINT_MIN_INTERVAL_MS = 60_000
export const WAL_CHECKPOINT_BYTES_THRESHOLD = 8 * 1024 * 1024

const state = { lastCheckpointAt: Date.now(), bytesSinceCheckpoint: 0, checkpointScheduled: false }

export function shouldCheckpointWal({ now, lastCheckpointAt, bytesSinceCheckpoint }) {
    if (bytesSinceCheckpoint <= 0) return false
    if (bytesSinceCheckpoint >= WAL_CHECKPOINT_BYTES_THRESHOLD) return true
    return now - lastCheckpointAt >= WAL_CHECKPOINT_MIN_INTERVAL_MS
}

export function resetWalCheckpointState() {
    state.lastCheckpointAt = Date.now()
    state.bytesSinceCheckpoint = 0
    state.checkpointScheduled = false
}

// Accrue bytes written by a successful sync push; maybe schedule one bounded checkpoint.
export function noteSyncWrite(bytes) {
    if (db.type !== 'sqlite' || !db.client) return
    const n = Number.isFinite(bytes) ? bytes : 0
    if (n <= 0) return
    state.bytesSinceCheckpoint += n
    if (state.checkpointScheduled) return
    if (!shouldCheckpointWal({ now: Date.now(), lastCheckpointAt: state.lastCheckpointAt, bytesSinceCheckpoint: state.bytesSinceCheckpoint })) return
    state.checkpointScheduled = true
    // Never on the response path: the push reply must not wait on the checkpoint.
    setImmediate(async () => {
        try {
            const rows = await db.pragma('wal_checkpoint(PASSIVE)')
            const row = Array.isArray(rows) ? rows[0] : rows
            state.lastCheckpointAt = Date.now()
            if (row && row.busy) {
                // Readers held the WAL: keep the pending bytes so the next write trigger
                // (or the interval) retries instead of dropping the accrual.
                trace('db', 'wal.checkpoint.busy', { result: row })
            } else {
                trace('db', 'wal.checkpoint', { result: row })
                state.bytesSinceCheckpoint = 0
            }
        } catch (err) {
            state.lastCheckpointAt = Date.now()
            trace('db', 'wal.checkpoint.failed', { error: err && err.message })
        } finally {
            state.checkpointScheduled = false
        }
    })
}
