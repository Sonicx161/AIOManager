import { autopilotDb as db } from '../write-tripwire.js'
import { encrypt } from '../../crypto.js'
import { PRIMARY_KEY } from '../../keys.js'
import { nextRuleVersion } from './rule-version.js'

export const stableStringify = (value) => {
    if (value === undefined) return 'undefined'
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    return `{${Object.keys(value)
        .filter(key => value[key] !== undefined)
        .sort()
        .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(',')}}`
}

// Compares plaintext (never encrypted blobs: the random IV makes those always differ).
export const addonListChanged = (storedKey, nextList) => storedKey !== stableStringify(nextList ?? null)

export async function runFullRuleUpdate(conn, [activeUrlToSave, addonListToSave, now, ruleId]) {
    if (addonListToSave == null) {
        return conn.run(`
            UPDATE autopilot_rules
            SET active_url = COALESCE($1, active_url), updated_at = ${nextRuleVersion('$2')}
            WHERE id = $3
        `, [activeUrlToSave, now, ruleId])
    }
    return conn.run(`
        UPDATE autopilot_rules
        SET active_url = COALESCE($1, active_url), addon_list = $2, updated_at = ${nextRuleVersion('$3')}
        WHERE id = $4
    `, [activeUrlToSave, addonListToSave, now, ruleId])
}

export function createCommit({ nowMs, setRuleRuntimeState, RULE_HEARTBEAT_MS }) {
    // Publishes the runtime state and returns the pending write (or null when nothing is due).
    const planCommit = ({ rule, stabilization, needsSync, syncSucceeded, hasChanged, decryptedActiveUrl, targetActiveUrl, reconciledList, updatedAddonList, storedAddonListKey, shouldUpdateNotificationTime, lastDeepAuditToSave }) => {
        const stabilizationJson = JSON.stringify(stabilization)
        const now = nowMs()
        // Counters live per target in memory; the stored snapshot is written only with a decision.
        const needsStatsUpdate = hasChanged && syncSucceeded
        const needsColdUpdate = needsSync && syncSucceeded
        const lastNotificationToSave = shouldUpdateNotificationTime ? now : (rule.last_notification || 0)

        setRuleRuntimeState(rule.id, {
            accountId: rule.account_id,
            lastCheck: now,
            lastNotification: lastNotificationToSave,
            stabilization,
            activeUrl: needsSync && !syncSucceeded ? decryptedActiveUrl : targetActiveUrl,
            ...(lastDeepAuditToSave != null ? { lastDeepAudit: lastDeepAuditToSave } : {})
        })

        if (!needsColdUpdate && !needsStatsUpdate) {
            const steadyHeartbeatDue = rule.last_check == null || now - rule.last_check >= RULE_HEARTBEAT_MS
            if (!steadyHeartbeatDue) return null
        }

        const stabilizationToSave = encrypt(stabilizationJson, PRIMARY_KEY)

        if (needsColdUpdate) {
            const activeUrlToSave = (hasChanged || !decryptedActiveUrl) ? encrypt(targetActiveUrl, PRIMARY_KEY) : null
            const nextAddonList = reconciledList ?? updatedAddonList
            const addonListToSave = addonListChanged(storedAddonListKey, nextAddonList)
                ? encrypt(JSON.stringify(nextAddonList), PRIMARY_KEY)
                : null

            return {
                type: 'full',
                ruleParams: [activeUrlToSave, addonListToSave, now, rule.id],
                statsParams: [rule.id, stabilizationToSave, now, lastNotificationToSave, now]
            }
        } else {
            // Heartbeats pass null so the upsert keeps the stored encrypted blob instead of rewriting it
            return {
                type: 'heartbeat',
                statsParams: [rule.id, null, now, lastNotificationToSave, now]
            }
        }
    }

    const flushUpdates = async (dirtyUpdates) => {
        if (dirtyUpdates.length === 0) return
        const fullUpdates = dirtyUpdates.filter(u => u.type === 'full')
        const heartbeatUpdates = dirtyUpdates.filter(u => u.type === 'heartbeat')
        await db.tx(async (conn) => {
            for (const update of fullUpdates) {
                await runFullRuleUpdate(conn, update.ruleParams)
            }
            const allStats = [...fullUpdates, ...heartbeatUpdates]
            for (let si = 0; si < allStats.length; si += 100) {
                const statChunk = allStats.slice(si, si + 100)
                const statRows = statChunk.map((_, j) => `($${j * 5 + 1}, $${j * 5 + 2}, $${j * 5 + 3}, $${j * 5 + 4}, $${j * 5 + 5})`).join(',')
                const statParams = statChunk.flatMap(u => u.statsParams)
                await conn.run(`
                    INSERT INTO autopilot_rule_stats (rule_id, stabilization, last_check, last_notification, updated_at)
                    VALUES ${statRows}
                    ON CONFLICT (rule_id) DO UPDATE SET
                        stabilization = COALESCE(EXCLUDED.stabilization, autopilot_rule_stats.stabilization),
                        last_check = EXCLUDED.last_check,
                        last_notification = EXCLUDED.last_notification,
                        updated_at = EXCLUDED.updated_at
                `, statParams)
            }
        })
    }

    return { planCommit, flushUpdates }
}
