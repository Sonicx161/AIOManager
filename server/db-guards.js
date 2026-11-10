import db from './db.js'
import { encrypt, decrypt } from './crypto.js'
import { PRIMARY_KEY, FALLBACK_KEYS } from './keys.js'

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * Midnight-prevention guard. Updates an encrypted column ONLY when its decrypted
 * plaintext actually changed.
 *
 * Why this exists: `encrypt()` uses a random IV, so re-encrypting identical data
 * always yields different ciphertext. Comparing ciphertext (or writing
 * unconditionally) makes the DB see a write every cycle, which is exactly what
 * caused the Midnight incident (1,368 autopilot rules → 2.8M `autopilot_rules`
 * UPDATEs / ~1.47TB writes in 38h). Any loop/heartbeat/high-frequency writer of
 * an encrypted or TOAST-heavy column MUST route through this helper (see
 * decisions.md → "Midnight Prevention").
 *
 * UPDATE-only: the target row must already exist. The first INSERT/upsert is not
 * the Midnight pattern (repeated rewrites of unchanged data are). Do that with a
 * normal upsert and use this helper for every subsequent write.
 *
 * @param {string} table   Table name. MUST be a trusted constant, never user input.
 * @param {{ sql: string, params: any[] }} where  Row selector using ascending `$1..$n`
 *                          placeholders, e.g. `{ sql: 'id = $1', params: [id] }`.
 * @param {string} column  Encrypted column to compare+write. Trusted constant.
 * @param {string} plaintext  New plaintext value (compared against the decrypted current value).
 * @param {object} [opts]
 * @param {Record<string, any>} [opts.alsoSet]  Extra columns to set on a real change,
 *                          e.g. `{ updated_at: Date.now() }`.
 * @param {{ get: Function, run: Function }} [opts.runner]  Optional tx runner from `db.tx`. Defaults to `db`.
 * @returns {Promise<{ written: boolean, outcome: 'written'|'unchanged'|'not-matched', plaintext?: string }>}
 *                          `outcome` separates the three results: 'unchanged' = the
 *                          stored plaintext already equals the new one (no write issued);
 *                          'written' = the guarded UPDATE matched a row and wrote;
 *                          'not-matched' = the UPDATE matched zero rows (row absent, or
 *                          its ownership changed under the selector). `written` keeps
 *                          its original meaning for existing callers. `plaintext` is
 *                          the value now stored (the new one, or the equal existing
 *                          one) so callers can fingerprint it without re-reading.
 */
export async function writeEncryptedIfChanged(table, where, column, plaintext, opts = {}) {
    if (!IDENT.test(table)) throw new Error(`writeEncryptedIfChanged: unsafe table name "${table}"`)
    if (!IDENT.test(column)) throw new Error(`writeEncryptedIfChanged: unsafe column name "${column}"`)
    const runner = opts.runner || db

    const current = await runner.get(
        `SELECT ${column} AS val FROM ${table} WHERE ${where.sql}`,
        where.params,
    )

    if (current) {
        try {
            const currentPlaintext = decrypt(current.val, FALLBACK_KEYS)
            if (currentPlaintext === plaintext) {
                return { written: false, outcome: 'unchanged', plaintext }
            }
        } catch {
        }
    }

    const extra = opts.alsoSet || {}
    const extraCols = Object.keys(extra)
    for (const col of extraCols) {
        if (!IDENT.test(col)) throw new Error(`writeEncryptedIfChanged: unsafe column name "${col}"`)
    }

    const setParamCount = 1 + extraCols.length
    const sets = [`${column} = $1`]
    const params = [encrypt(plaintext, PRIMARY_KEY)]
    let p = 2
    for (const col of extraCols) {
        sets.push(`${col} = $${p++}`)
        params.push(extra[col])
    }

    // WHERE params follow the SET params, so renumber the selector's placeholders.
    const whereSql = where.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + setParamCount}`)
    params.push(...where.params)

    const res = await runner.run(
        `UPDATE ${table} SET ${sets.join(', ')} WHERE ${whereSql}`,
        params,
    )
    const matched = (res?.changes || 0) > 0
    return { written: matched, outcome: matched ? 'written' : 'not-matched', ...(matched ? { plaintext } : {}) }
}
