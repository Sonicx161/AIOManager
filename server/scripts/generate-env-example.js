// Regenerates the repo-root .env.example from the schema in server/lib/env.js.
// Usage: npm --prefix server run gen:env (add -- --stdout to print instead of writing)

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

process.env.SKIP_ENV_VALIDATION = '1' // must be set before env.js is loaded
const { ENV_META, ENV_GROUPS } = await import('../lib/env.js')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TARGET = path.join(__dirname, '..', '..', '.env.example')

// Variables emitted uncommented (values equal the code defaults, so copying
// this file verbatim changes nothing). Everything else is emitted commented.
const ACTIVE = new Set([
    'PORT', 'NODE_ENV', 'DB_TYPE', 'LOG_LEVEL', 'LOG_PRETTY_PRINT',
    ...ENV_GROUPS.find((g) => g.title.startsWith('ACTIVITY')).vars,
])

const RULE = '# =============================================================================='

function wrap(text, width = 78) {
    const words = text.split(/\s+/)
    const lines = []
    let line = ''
    for (const word of words) {
        if (line && (line + ' ' + word).length > width) {
            lines.push(line)
            line = word
        } else {
            line = line ? line + ' ' + word : word
        }
    }
    if (line) lines.push(line)
    return lines
}

function specLine(name) {
    const meta = ENV_META[name]
    const parts = [meta.type]
    if (meta.allowed) parts.push(`one of: ${meta.allowed.join(', ')}`)
    else if (meta.default === null) parts.push('optional')
    else if (meta.defaultLabel) parts.push(`default: ${meta.defaultLabel}`)
    else if (meta.type === 'boolean') parts.push(`default: ${meta.default}`)
    else if (meta.type === 'integer') {
        parts.push(`default: ${meta.default}`)
        const range = meta.max !== undefined ? `${meta.min}..${meta.max}` : meta.min !== undefined ? `>= ${meta.min}` : ''
        if (range) parts.push(range)
    } else parts.push(`default: ${meta.default}`)
    return `# ${parts.join(' | ')}`
}

function valueFor(name) {
    const meta = ENV_META[name]
    if (meta.type === 'boolean') return String(meta.default)
    if (meta.default === null) return ''
    if (name === 'DATA_DIR') return '/app/data'
    if (meta.type === 'comma-separated list') return ''
    return String(meta.default)
}

// Fail loudly if schema and groups drift apart.
const grouped = ENV_GROUPS.flatMap((g) => g.vars)
const metaKeys = Object.keys(ENV_META)
const drift = metaKeys.filter((k) => !grouped.includes(k))
    .concat(grouped.filter((k) => !metaKeys.includes(k)))
    .concat(grouped.filter((k, i) => grouped.indexOf(k) !== i))
if (drift.length) {
    console.error(`ENV_GROUPS out of sync with schema (missing/duplicate): ${drift.join(', ')}`)
    process.exit(1)
}

const out = []
out.push(RULE)
out.push('#      ___   _ _______  __  __')
out.push('#     /   | (_) ____/ |/ / / /___ _____  ____ _____ ____  _____')
out.push('#    / /| |/ / /   / /|_/ / __ `/ __ \\/ __ `/ __ `/ _ \\/ ___/')
out.push('#   / ___ / / /___/ /  / / /_/ / /_/ / /_/ / /_/ /  __/ /')
out.push('#  /_/  |_\\_\\____/_/  /_/\\__,_/_/ /_/\\__,_/\\__, /\\___/_/')
out.push('#                                         /____/')
out.push(RULE)
out.push('#  One manager to rule them all. Local-first, Encrypted, Powerful.')
out.push(RULE)
out.push('#')
out.push('# This file is GENERATED from the validated schema in server/lib/env.js.')
out.push('# Every variable below is checked at server boot: wrong types or out-of-range')
out.push('# values stop the process with a message naming the variable. Defaults shown')
out.push('# here are the exact code defaults.')
out.push('#')
out.push('# Regenerate after changing the schema:  npm --prefix server run gen:env')
out.push('#')

for (const group of ENV_GROUPS) {
    out.push('')
    out.push(RULE)
    out.push(`#  ${group.title}`)
    out.push(RULE)
    if (group.note) for (const line of wrap(group.note)) out.push(`# ${line}`)
    for (const name of group.vars) {
        const meta = ENV_META[name]
        out.push('')
        out.push(`# --- ${name} ---`)
        for (const line of wrap(meta.desc)) out.push(`# ${line}`)
        out.push(specLine(name))
        if (meta.example) out.push(`# Example: ${name}=${meta.example}`)
        const value = valueFor(name)
        out.push(ACTIVE.has(name) ? `${name}=${value}` : `#${name}=${value}`)
    }
}

out.push('')
if (process.argv.includes('--stdout')) {
    process.stdout.write(out.join('\n') + '\n')
} else {
    fs.writeFileSync(TARGET, out.join('\n') + '\n', 'utf8')
    console.log(`Wrote ${TARGET} (${metaKeys.length} variables, ${ENV_GROUPS.length} groups)`)
}
