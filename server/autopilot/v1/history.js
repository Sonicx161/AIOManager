import { autopilotDb as db } from '../write-tripwire.js'
import { encrypt, generateRandomKey } from '../../crypto.js'
import { PRIMARY_KEY } from '../../keys.js'

export function createHistory({ fastify, nowMs }) {
    const recordFailoverHistory = async (rule, type, message, primaryUrl, activeUrl, metadata = null, latencyMs = null) => {
        try {
            const id = generateRandomKey().substring(0, 16)

            const encryptedPrimary = encrypt(primaryUrl, PRIMARY_KEY)
            const encryptedActive = encrypt(activeUrl, PRIMARY_KEY)
            const encryptedMsg = encrypt(message, PRIMARY_KEY)
            const encryptedMeta = metadata ? encrypt(JSON.stringify(metadata), PRIMARY_KEY) : null

            await db.run(`
                INSERT INTO failover_history (id, timestamp, type, rule_id, account_id, primary_name, backup_name, message, metadata, latency_ms)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [id, nowMs(), type, rule.id, rule.account_id, encryptedPrimary, encryptedActive, encryptedMsg, encryptedMeta, latencyMs])

            // High-Scale Optimization: Keep only 10 records per account.
            // NOTE: $1 is used twice. For SQLite, the db layer converts $N to ?,
            // so we must pass every param twice in the params array.
            const owner = rule.owner_sync_user !== undefined
                ? rule.owner_sync_user
                : ((await db.get('SELECT owner_sync_user FROM autopilot_rules WHERE id = $1', [rule.id]))?.owner_sync_user ?? null)
            const ownerScope = owner ? 'rule_id IN (SELECT id FROM autopilot_rules WHERE owner_sync_user = $2)' : 'rule_id = $2'
            const ownerScopeInner = owner ? 'rule_id IN (SELECT id FROM autopilot_rules WHERE owner_sync_user = $4)' : 'rule_id = $4'
            const scopeKey = owner || rule.id
            await db.run(`
                DELETE FROM failover_history 
                WHERE account_id = $1 
                AND ${ownerScope}
                AND id NOT IN (
                    SELECT id FROM (
                        SELECT id FROM failover_history 
                        WHERE account_id = $3 
                        AND ${ownerScopeInner}
                        ORDER BY timestamp DESC 
                        LIMIT 10
                    ) AS x
                )
            `, [rule.account_id, scopeKey, rule.account_id, scopeKey])
        } catch (err) {
            fastify.log.error({ category: 'Autopilot' }, `History record failed: ${err.message}`)
        }
    }

    return { recordFailoverHistory }
}
