import { autopilotDb as db } from '../write-tripwire.js'
import { normalizeAddonUrl } from '../../utils/addon-url.js'
import { urlRef } from './url-ref.js'

export const SWAP_WINDOW_MS = 60 * 60 * 1000
export const MAX_SWAPS = 4
export const FIGHT_TYPE = 'contested'

export function createConflictState({ nowMs, maxEntries = 10000 }) {
    const own = new Map()
    const notices = new Map()
    const bypass = new Set()
    let recordHistory = null
    const norm = url => normalizeAddonUrl(url || '').toLowerCase()
    const cap = (map, max) => { while (map.size > max) map.delete(map.keys().next().value) }

    const getHold = ruleId => {
        const entry = notices.get(ruleId)
        if (!entry) return null
        if (entry.retryAt <= nowMs()) { notices.delete(ruleId); return null }
        return { urls: [], affectedRefs: entry.refs, retryAt: entry.retryAt, retryHours: SWAP_WINDOW_MS / 3600000 }
    }
    const fightBudget = async (rule, chain = []) => {
        if (bypass.delete(rule.id)) { notices.delete(rule.id); return null }
        const since = nowMs() - SWAP_WINDOW_MS
        const rows = await db.query(
            `SELECT timestamp FROM failover_history WHERE rule_id = $1 AND timestamp > $2 AND type = '${FIGHT_TYPE}' ORDER BY timestamp DESC LIMIT ${MAX_SWAPS}`,
            [rule.id, since])
        const mine = (own.get(rule.id) || []).filter(at => at > since)
        const times = (rows?.length || 0) >= mine.length ? (rows || []).map(row => Number(row.timestamp)) : mine
        if (times.length < MAX_SWAPS) { notices.delete(rule.id); return null }
        notices.set(rule.id, { accountId: rule.account_id, retryAt: times[MAX_SWAPS - 1] + SWAP_WINDOW_MS, refs: chain.map(url => urlRef(url)) })
        cap(notices, maxEntries)
        return getHold(rule.id)
    }
    const classifyWrite = async (rule, chain, target, liveOn, { healthSwap = false } = {}) => {
        if (healthSwap) return {}
        const wanted = norm(target)
        const live = [...new Set((liveOn || []).map(norm).filter(Boolean))]
        if (live.length === 1 && live[0] === wanted) return {}
        const hold = await fightBudget(rule, chain)
        return hold ? { hold: { ...hold, urls: live } } : { charged: true }
    }
    const recordFight = async (rule, chain, target) => {
        const times = (own.get(rule.id) || []).filter(at => at > nowMs() - SWAP_WINDOW_MS)
        times.unshift(nowMs())
        own.delete(rule.id)
        own.set(rule.id, times.slice(0, MAX_SWAPS))
        cap(own, maxEntries)
        if (recordHistory) await recordHistory(rule, FIGHT_TYPE, 'Another writer changed this rule. Autopilot switched it back.', chain?.[0] || '', target, { activeUrl: norm(target) })
    }
    const retry = ruleId => {
        if (!getHold(ruleId)) return false
        notices.delete(ruleId)
        bypass.add(ruleId)
        cap(bypass, maxEntries)
        return true
    }
    const clear = ruleId => { bypass.delete(ruleId); return notices.delete(ruleId) }
    const clearAccount = accountId => {
        for (const [id, entry] of notices) if (entry.accountId === accountId) notices.delete(id)
    }
    const none = () => null
    return {
        fightBudget, classifyWrite, recordFight, getHold, retry, clear, clearAccount,
        setRecorder: fn => { recordHistory = fn },
        recordWrite: none, observe: none, observeLive: none, resetForIncident: () => false, getAccountProtectedUrls: () => [],
    }
}
