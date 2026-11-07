// Generates server/openapi.json by booting the real server (server/index.js) on a
// scratch port with an isolated throwaway DATA_DIR, fetching /openapi.json, and
// shutting down. index.js builds the app as a side effect of import (top-level
// awaits, engines, signal handlers), so refactoring a listen-less buildApp() out of
// it would be invasive; a short-lived child process is the less invasive contract
// source. Output is deterministic for a given code state: route registration order
// is fixed and the spec is serialized with stable key order.
import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.resolve(__dirname, '..')
const outputFile = path.join(serverRoot, 'openapi.json')
const BOOT_TIMEOUT_MS = 60_000
const KILL_TIMEOUT_MS = 5_000

function getFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer()
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address()
            probe.close(() => resolve(port))
        })
        probe.on('error', reject)
    })
}

function tail(buffer) {
    return buffer.slice(-4000).toString('utf8')
}

const port = await getFreePort()
const dataDir = path.join(os.tmpdir(), `aiomanager-openapi-${process.pid}`)

const child = spawn(process.execPath, ['index.js'], {
    cwd: serverRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        // Workers off instead of READ_ONLY_REPLICA: env validation rejects a SQLite replica.
        AUTOPILOT_WORKER: 'off',
        ACTIVITY_ENGINE_ENABLED: 'false',
        LOG_PRETTY_PRINT: 'false',
        LOG_LEVEL: 'warn',
        CUSTOM_HTML: ''
    }
})

let stdout = Buffer.alloc(0)
let stderr = Buffer.alloc(0)
child.stdout.on('data', (chunk) => { stdout = Buffer.concat([stdout, chunk]) })
child.stderr.on('data', (chunk) => { stderr = Buffer.concat([stderr, chunk]) })

const childExited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))

async function fetchSpec() {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    const url = `http://127.0.0.1:${port}/openapi.json`
    while (Date.now() < deadline) {
        const earlyExit = await Promise.race([childExited, new Promise((r) => setTimeout(r, 0, null))])
        if (earlyExit) {
            throw new Error(`server exited before exposing the spec (code=${earlyExit.code} signal=${earlyExit.signal})\n${tail(stdout)}\n${tail(stderr)}`)
        }
        try {
            const response = await fetch(url)
            if (response.ok) return await response.json()
        } catch {}
        await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`timed out after ${BOOT_TIMEOUT_MS}ms waiting for ${url}\n${tail(stdout)}\n${tail(stderr)}`)
}

try {
    const spec = await fetchSpec()
    fs.writeFileSync(outputFile, JSON.stringify(spec, null, 2) + '\n')
    const paths = Object.keys(spec.paths || {})
    console.log(`openapi.json written: ${outputFile} (${paths.length} paths, openapi ${spec.openapi})`)
} finally {
    child.kill()
    await Promise.race([
        childExited,
        new Promise((r) => setTimeout(r, KILL_TIMEOUT_MS)).then(() => child.kill('SIGKILL'))
    ])
    fs.rmSync(dataDir, { recursive: true, force: true })
}
