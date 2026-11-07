import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const root = path.resolve(process.argv[2] || 'dist')
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.txt', '.xml', '.webmanifest', '.ttf', '.otf', '.wasm'])
const MIN_BYTES = 1024

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
})

const write = (file, ext, compressed, original) => {
    const out = file + ext
    if (compressed.length < original.length) fs.writeFileSync(out, compressed)
    else fs.rmSync(out, { force: true })
}

if (!fs.existsSync(root)) {
    console.error(`precompress: ${root} does not exist`)
    process.exit(1)
}

let files = 0
let rawBytes = 0
let brBytes = 0
for (const file of walk(root)) {
    if (!COMPRESSIBLE.has(path.extname(file).toLowerCase())) continue
    const original = fs.readFileSync(file)
    if (original.length < MIN_BYTES) continue
    const br = zlib.brotliCompressSync(original, {
        params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: original.length,
        },
    })
    write(file, '.br', br, original)
    write(file, '.gz', zlib.gzipSync(original, { level: 9 }), original)
    files++
    rawBytes += original.length
    brBytes += Math.min(br.length, original.length)
}
console.log(`precompress: ${files} files, ${rawBytes} -> ${brBytes} bytes (br)`)
