// Install before importing server modules: tests never inherit application data or
// send unconfigured outbound requests. Individual tests provide their own fetch doubles.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dnsPromises from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiomanager-server-smoke-'))
process.env.DATA_DIR = root
process.env.SQLITE_DB_PATH = ':memory:'
process.env.DB_TYPE = 'sqlite'
process.env.ENCRYPTION_KEY = 'synthetic-smoke-encryption-key-only'
delete process.env.DATABASE_URL
delete process.env.AIOMAN_TRACE
process.env.SSRF_ALLOW_PRIVATE = 'false'

const blocked = () => { throw new Error('Unmocked network blocked by isolated smoke preload') }
globalThis.fetch = async () => blocked()
http.request = http.get = https.request = https.get = blocked
dnsPromises.lookup = async (hostname, options = {}) => {
    // Reserved fixture domains get a documentation-only address. Everything else
    // fails locally instead of reaching the machine's DNS resolver.
    if (!String(hostname).endsWith('.example') && !String(hostname).endsWith('.invalid')) return blocked()
    const record = { address: '203.0.113.10', family: 4 }
    return options.all ? [record] : record
}
syncBuiltinESMExports()

process.on('exit', () => {
    const resolved = path.resolve(root)
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('aiomanager-server-smoke-')) {
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
