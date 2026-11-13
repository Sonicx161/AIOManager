// Boot transfer budget and CSP inline-script hash check for the built app; run after npm run build.
// Usage: node scripts/check-boot-budget.mjs [--measure prints today's numbers for the budget constants]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const BOOT_FILES_BUDGET = 33
const BOOT_RAW_BUDGET = 1404000
const BOOT_GZIP_BUDGET = 395000
const BOOT_BROTLI_BUDGET = 336000

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(root, 'dist'))
const measure = process.argv.includes('--measure')
const htmlPath = path.join(dist, 'index.html')

if (!fs.existsSync(htmlPath)) {
    console.error('boot-budget: dist/index.html not found; run npm run build first')
    process.exit(1)
}
const html = fs.readFileSync(htmlPath, 'utf8')

const entryScripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+\.js)"[^>]*>/g)].map((m) => m[1])
const modulePreloads = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*\/?>/g)]
    .map((m) => m[0].match(/href="([^"]+)"/)?.[1])
    .filter(Boolean)
const cssPreloads = [...html.matchAll(/<link[^>]*rel="preload"[^>]*\/?>/g)]
    .filter((m) => m[0].includes('as="style"'))
    .map((m) => m[0].match(/href="([^"]+)"/)?.[1])
    .filter(Boolean)
const stylesheetLinks = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*\/?>/g)]
    .map((m) => m[0].match(/href="([^"]+)"/)?.[1])
    .filter(Boolean)

const files = [...new Set([...entryScripts, ...modulePreloads, ...cssPreloads, ...stylesheetLinks])]
if (files.length === 0) {
    console.error('boot-budget: no entry script or preload links found in dist/index.html')
    process.exit(1)
}

const sizeOf = (file) => {
    const raw = fs.statSync(file).size
    const sidecar = (ext, compress) => {
        const p = `${file}${ext}`
        if (fs.existsSync(p)) return Math.min(fs.statSync(p).size, raw)
        return Math.min(compress(fs.readFileSync(file)).length, raw)
    }
    return {
        raw,
        gzip: sidecar('.gz', (buf) => zlib.gzipSync(buf, { level: 9 })),
        brotli: sidecar('.br', (buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })),
    }
}

const total = { files: files.length, raw: 0, gzip: 0, brotli: 0 }
const missing = []
for (const file of files) {
    const full = path.join(dist, file.replace(/^\//, ''))
    if (!fs.existsSync(full)) {
        missing.push(file)
        continue
    }
    const s = sizeOf(full)
    total.raw += s.raw
    total.gzip += s.gzip
    total.brotli += s.brotli
}
if (missing.length > 0) {
    console.error(`boot-budget: files referenced by index.html are missing from dist: ${missing.join(', ')}`)
    process.exit(1)
}

const inlineScripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
const builtHashes = inlineScripts.map((code) => `sha256-${crypto.createHash('sha256').update(code).digest('base64')}`)

const mainPath = path.join(root, 'server', 'main.js')
if (!fs.existsSync(mainPath)) {
    console.error('boot-budget: server/main.js not found')
    process.exit(1)
}
const csp = fs.readFileSync(mainPath, 'utf8').match(/Content-Security-Policy',\s*"([^"]+)"/)?.[1]
if (!csp) {
    console.error('boot-budget: could not find the Content-Security-Policy header string in server/main.js')
    process.exit(1)
}
const directives = new Map(csp.split(';').map((part) => {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    return tokens.length ? [tokens[0].toLowerCase(), tokens.slice(1).join(' ')] : null
}).filter(Boolean))
const scriptSrc = directives.get('script-src') ?? ''
const pinnedHashes = [...scriptSrc.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map((m) => m[1])

const fmt = (n) => n.toLocaleString('en-US')
console.log(`boot set: ${total.files} files (${entryScripts.length} entry, ${modulePreloads.length} modulepreload, ${cssPreloads.length} css preload, ${stylesheetLinks.length} stylesheet link), ${fmt(total.raw)} B raw / ${fmt(total.gzip)} B gzip / ${fmt(total.brotli)} B brotli`)

if (measure) {
    console.log('\nmeasured today; paste into scripts/check-boot-budget.mjs:')
    console.log(`const BOOT_FILES_BUDGET = ${total.files}`)
    console.log(`const BOOT_RAW_BUDGET = ${total.raw}`)
    console.log(`const BOOT_GZIP_BUDGET = ${total.gzip}`)
    console.log(`const BOOT_BROTLI_BUDGET = ${total.brotli}`)
    process.exit(0)
}

let failed = false
const check = (label, actual, budget, unit = 'B') => {
    if (actual > budget) {
        console.error(`boot-budget: FAIL ${label} ${fmt(actual)}${unit === 'B' ? ' B' : ''} exceeds the budget ${fmt(budget)}${unit === 'B' ? ' B' : ''} (${((actual / budget - 1) * 100).toFixed(1)}% over).`)
        console.error('boot-budget: if the growth is intended, re-measure with `node scripts/check-boot-budget.mjs --measure` and update the budget constants.')
        failed = true
    } else {
        console.log(`boot-budget: ${label} ${fmt(actual)} / ${fmt(budget)}${unit === 'B' ? ' B' : ''}`)
    }
}
check('files', total.files, BOOT_FILES_BUDGET, 'files')
check('raw', total.raw, BOOT_RAW_BUDGET)
check('gzip', total.gzip, BOOT_GZIP_BUDGET)
check('brotli', total.brotli, BOOT_BROTLI_BUDGET)

const unpinned = builtHashes.filter((h) => !pinnedHashes.includes(h))
const stale = pinnedHashes.filter((h) => !builtHashes.includes(h))
if (unpinned.length > 0 || stale.length > 0) {
    console.error('boot-budget: FAIL the script-src hashes pinned in server/main.js do not match the built page inline scripts.')
    for (const h of unpinned) console.error(`  built page needs:  '${h}'`)
    for (const h of stale) console.error(`  pinned but stale:  '${h}'`)
    console.error('boot-budget: update the script-src directive in server/main.js to the hashes above (the inline boot script changed).')
    failed = true
} else {
    console.log(`boot-budget: CSP script-src hashes match server/main.js (${builtHashes.length} pinned)`)
}

process.exit(failed ? 1 : 0)
