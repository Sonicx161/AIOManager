process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32bytes-long!!'

import test, { before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import net from 'node:net'
import pg from 'pg'
import { assertPostgresSmokeUrl } from './helpers.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const skip = process.env.DB_TYPE !== 'postgres' || !TEST_DATABASE_URL
const port = Number(process.env.SMOKE_SERVER_PORT || 17771)
const base = `http://127.0.0.1:${port}`

describe('server boot and sync on postgres', { skip: skip || undefined }, () => {
    let server
    let dataDir
    let serverOutput = ''
    let exited = false
    const user = `pg-smoke-${Date.now().toString(36)}`
    const password = 'pg-smoke-pass-1'

    before(async () => {
        assertPostgresSmokeUrl(TEST_DATABASE_URL)
        const reset = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 })
        await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
        await reset.end()

        try {
            const probe = net.createServer()
            await new Promise((resolve, reject) => {
                probe.once('error', reject)
                probe.listen(port, '127.0.0.1', () => resolve())
            })
            await new Promise((resolve) => probe.close(resolve))
        } catch {
            throw new Error(`port ${port} is already in use; the smoke server cannot start`)
        }

        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiom-pg-smoke-'))
        const serverEnv = {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'production',
            DATA_DIR: dataDir,
            DB_TYPE: 'postgres',
            DATABASE_URL: TEST_DATABASE_URL,
            AUTOPILOT_WORKER: 'off',
            ACTIVITY_ENGINE_ENABLED: 'false',
        }
        delete serverEnv.TEST_DATABASE_URL
        server = spawn(process.execPath, ['index.js'], {
            cwd: path.resolve(import.meta.dirname, '..'),
            env: serverEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        const collect = (chunk) => {
            serverOutput += chunk
            if (serverOutput.length > 20000) serverOutput = serverOutput.slice(-20000)
        }
        server.stdout.on('data', collect)
        server.stderr.on('data', collect)
        server.on('exit', (code) => {
            if (!exited) console.error(`server exited early with code ${code}:\n${serverOutput}`)
        })

        let lastError = null
        for (let attempt = 0; attempt < 150; attempt++) {
            if (server.exitCode !== null) {
                throw new Error(`server exited with code ${server.exitCode} before becoming healthy:\n${serverOutput}`)
            }
            try {
                const res = await fetch(`${base}/api/health`)
                if (res.ok) {
                    const body = await res.json()
                    if (body.status === 'ok' && body.database?.type === 'postgres' && body.database?.healthy) {
                        lastError = null
                        break
                    }
                    lastError = `unhealthy body: ${JSON.stringify(body).slice(0, 300)}`
                } else {
                    lastError = `health returned ${res.status}`
                }
            } catch (err) {
                const cause = err?.cause ? ` (${err.cause.code || err.cause.message})` : ''
                lastError = `${err.message}${cause}`
            }
            await new Promise((resolve) => setTimeout(resolve, 600))
        }
        if (lastError) throw new Error(`server never became healthy on postgres: ${lastError}\n${serverOutput}`)

        // On a fresh database the account-state gate stays 503 until its first
        // background load lands (the table is created after the boot preload).
        for (let attempt = 0; attempt < 90; attempt++) {
            const res = await fetch(`${base}/api/sync/__smoke_readiness__`, {
                headers: { 'x-sync-password': 'unused' },
            })
            if (res.status !== 503) break
            if (attempt === 89) throw new Error(`account-state gate still 503 after 90s:\n${serverOutput}`)
            await new Promise((resolve) => setTimeout(resolve, 1000))
        }
    })

    after(async () => {
        exited = true
        if (server && server.exitCode === null) {
            server.kill()
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 10000)
                server.once('exit', () => { clearTimeout(timer); resolve() })
            }).finally(() => { if (server.exitCode === null) server.kill('SIGKILL') })
        }
        if (dataDir) {
            try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* Windows may hold files briefly */ }
        }
    })

    test('health reports a healthy postgres database', async () => {
        const res = await fetch(`${base}/api/health`)
        assert.equal(res.status, 200)
        const body = await res.json()
        assert.equal(body.status, 'ok')
        assert.equal(body.database.type, 'postgres')
        assert.equal(body.database.healthy, true)
    })

    test('sync push registers the account and stores the workspace', async () => {
        const res = await fetch(`${base}/api/sync/${user}`, {
            method: 'POST',
            headers: { 'x-sync-password': password, 'content-type': 'application/json' },
            body: JSON.stringify({ smoke: 'postgres', markers: [1, 2, 3], accounts: [] }),
        })
        const text = await res.text()
        assert.equal(res.status, 200, `body: ${text}`)
        const body = JSON.parse(text)
        assert.equal(body.success, true)
        assert.ok(typeof body.syncedAt === 'string' && body.syncedAt.length > 0)
        assert.ok(typeof body.contentHash === 'string' && body.contentHash.length > 0)
    })

    test('pull returns the pushed workspace', async () => {
        const res = await fetch(`${base}/api/sync/${user}`, {
            headers: { 'x-sync-password': password },
        })
        const text = await res.text()
        assert.equal(res.status, 200, `body: ${text}`)
        const body = JSON.parse(text)
        assert.equal(body.smoke, 'postgres')
        assert.deepEqual(body.markers, [1, 2, 3])
        assert.ok(typeof body.syncedAt === 'string')
    })

    test('pull with the wrong password is rejected', async () => {
        const res = await fetch(`${base}/api/sync/${user}`, {
            headers: { 'x-sync-password': 'not-the-password' },
        })
        assert.equal(res.status, 401)
    })

    test('a second changed push archives history and restore rolls back to it', async () => {
        const push2 = await fetch(`${base}/api/sync/${user}`, {
            method: 'POST',
            headers: { 'x-sync-password': password, 'content-type': 'application/json' },
            body: JSON.stringify({ smoke: 'postgres-2', markers: [4], accounts: [] }),
        })
        const push2Text = await push2.text()
        assert.equal(push2.status, 200, `body: ${push2Text}`)
        assert.equal(JSON.parse(push2Text).success, true)

        const restore = await fetch(`${base}/api/sync/${user}/restore`, {
            method: 'POST',
            headers: { 'x-sync-password': password },
        })
        const restoreText = await restore.text()
        assert.equal(restore.status, 200, `body: ${restoreText}`)
        assert.equal(JSON.parse(restoreText).restored, true)

        const pulled = await fetch(`${base}/api/sync/${user}`, {
            headers: { 'x-sync-password': password },
        })
        const pulledText = await pulled.text()
        assert.equal(pulled.status, 200, `body: ${pulledText}`)
        assert.equal(JSON.parse(pulledText).smoke, 'postgres')
    })
})
