import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { buildRows, writeRowsInTx } from './cinemeta-cache.js'

const client = new Database(workerData.dbPath)
client.pragma('busy_timeout = 5000')

const runner = {
    query: (sql, params = []) => client.prepare(sql).all(params),
    get: (sql, params = []) => client.prepare(sql).get(params),
    run: (sql, params = []) => ({ changes: client.prepare(sql).run(params).changes }),
}

parentPort.on('message', async ({ id, entries, stamp, rowEstimate, maxRows }) => {
    try {
        const rows = buildRows(entries, stamp)
        if (rows.length === 0) {
            parentPort.postMessage({ id, result: { rows: 0, total: rowEstimate, pruned: 0 } })
            return
        }
        client.exec('BEGIN IMMEDIATE')
        try {
            const outcome = await writeRowsInTx(runner, rows, { rowEstimate, maxRows })
            client.exec('COMMIT')
            parentPort.postMessage({ id, result: { rows: rows.length, ...outcome } })
        } catch (error) {
            try { client.exec('ROLLBACK') } catch { /* connection already rolled back */ }
            throw error
        }
    } catch (error) {
        parentPort.postMessage({ id, error: error.message })
    }
})
