import crypto from 'crypto'
import { promisify } from 'util'
import { ADMIN_LIMITS } from './config.js'

// Format: scrypt:<log2N>:<r>:<p>:<saltHex>:<hashHex>. Colons, not `$`, so compose files
// never interpolate it. Separate from sync SCRYPT_PARAMS, which must never change.
const scryptAsync = promisify(crypto.scrypt)
const HASH_RE = /^scrypt:(\d{2}):(\d{1,2}):(\d{1,2}):([0-9a-f]{32}):([0-9a-f]{64})$/
export const DEFAULT_LOG2N = 17
const MIN_LOG2N = 14
const MAX_LOG2N = 20
const KEY_LEN = 32

const BLOCKLIST = [
    'password', 'passphrase', 'aiomanager', 'dashboard', 'administrator', 'admin', 'letmein',
    'qwerty', 'welcome', 'changeme', 'stremio', 'iloveyou', 'abc123', '123456', 'secret',
]

export const kdfStats = { runs: 0 }

// scrypt needs about 128 * N * r bytes; a stored hash may not ask for more than this.
export const MAX_SCRYPT_BYTES = 256 * 1024 * 1024

// null when the stored value is a usable hash, otherwise 'format' or 'memory'.
export function adminHashProblem(stored) {
    if (typeof stored !== 'string') return 'format'
    const m = HASH_RE.exec(stored.trim())
    if (!m) return 'format'
    const log2N = Number(m[1]); const r = Number(m[2]); const p = Number(m[3])
    if (log2N < MIN_LOG2N || log2N > MAX_LOG2N || r < 1 || r > 32 || p < 1 || p > 4) return 'format'
    if (128 * 2 ** log2N * r > MAX_SCRYPT_BYTES) return 'memory'
    return null
}

export function parseAdminHash(stored) {
    if (adminHashProblem(stored)) return null
    const m = HASH_RE.exec(stored.trim())
    return { log2N: Number(m[1]), r: Number(m[2]), p: Number(m[3]), salt: Buffer.from(m[4], 'hex'), hash: Buffer.from(m[5], 'hex') }
}

const derive = (passphrase, salt, { log2N, r, p }) => {
    kdfStats.runs++
    const N = 2 ** log2N
    return scryptAsync(String(passphrase), salt, KEY_LEN, { N, r, p, maxmem: 256 * N * r + 16 * 1024 * 1024 })
}

export async function hashAdminPassphrase(passphrase, { log2N = DEFAULT_LOG2N, r = 8, p = 1, salt = crypto.randomBytes(16) } = {}) {
    const hash = await derive(passphrase, salt, { log2N, r, p })
    return `scrypt:${log2N}:${r}:${p}:${salt.toString('hex')}:${hash.toString('hex')}`
}

let dummy = null
const dummyFor = (params) => {
    const key = `${params.log2N}:${params.r}:${params.p}`
    if (!dummy || dummy.key !== key) dummy = { key, params, salt: crypto.randomBytes(16), hash: crypto.randomBytes(KEY_LEN) }
    return dummy
}

// Always runs exactly one KDF, even when nothing is configured or the input is malformed,
// so response timing never reveals which case applied.
export async function verifyAdminPassphrase(passphrase, stored, fallbackParams = { log2N: DEFAULT_LOG2N, r: 8, p: 1 }) {
    const parsed = parseAdminHash(stored)
    const input = typeof passphrase === 'string' && passphrase.length <= 1024 ? passphrase : ''
    const target = parsed || dummyFor(fallbackParams)
    const computed = await derive(input, target.salt, parsed || target.params)
    const match = crypto.timingSafeEqual(computed, target.hash)
    return Boolean(parsed) && input.length > 0 && match
}

export function passphraseProblem(passphrase) {
    if (typeof passphrase !== 'string' || !passphrase) return 'Password is required'
    if (passphrase.length < ADMIN_LIMITS.minPassphraseLength) return `Use at least ${ADMIN_LIMITS.minPassphraseLength} characters`
    if (passphrase.length > 1024) return 'Password is too long'
    if (new Set(passphrase).size < 5) return 'Password is too repetitive'
    const lower = passphrase.toLowerCase().replace(/[^a-z0-9]/g, '')
    for (const word of BLOCKLIST) {
        if (lower.replaceAll(word, '').length < 8) return 'Password is too common'
    }
    return null
}

// Credentials stored before usernames existed sign in as this name.
export const LEGACY_ADMIN_USERNAME = 'admin'
const MAX_USERNAME = 64

export const normalizeAdminUsername = (username) => typeof username === 'string' ? username.normalize('NFKC').trim().toLowerCase() : ''

export function usernameProblem(username) {
    const name = normalizeAdminUsername(username)
    if (!name) return 'Username is required'
    if (name.length > MAX_USERNAME) return `Use at most ${MAX_USERNAME} characters for the username`
    if (/[\p{Cc}\p{Cf}]/u.test(name)) return 'Username contains characters that are not allowed'
    return null
}

// Split only the first colon so the operator's password may contain colons or spaces.
export function parseAdminCredentials(value) {
    if (typeof value !== 'string') return null
    const separator = value.indexOf(':')
    if (separator < 1) return null
    const username = value.slice(0, separator)
    const password = value.slice(separator + 1)
    // The operator chooses the .env password; keep only the login input bound.
    if (usernameProblem(username) || !password.trim() || password.length > 1024) return null
    return { username: normalizeAdminUsername(username), password }
}

// One KDF for every input, and the username is compared by digest in constant time, so
// neither the result nor its timing shows which field was wrong or whether the name exists.
export async function verifyAdminLogin(username, password, storedUsername, storedHash, fallbackParams) {
    const digest = (v) => crypto.createHash('sha256').update(String(v)).digest()
    const given = normalizeAdminUsername(username)
    const expected = normalizeAdminUsername(storedUsername)
    const nameOk = crypto.timingSafeEqual(digest(given), digest(expected)) && given.length > 0 && given.length <= MAX_USERNAME
    const passOk = await verifyAdminPassphrase(password, storedHash, fallbackParams)
    return nameOk && passOk
}
