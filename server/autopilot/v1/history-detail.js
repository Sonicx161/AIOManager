import { normalizeAddonUrl } from '../../utils/addon-url.js'

const TIMEOUT_ROWS = new Set(['ping-timeout', 'connect-timeout', 'response-timeout'])
const norm = (url) => normalizeAddonUrl(url || '').toLowerCase()

// A short, URL-free code for a failed platform push; raw driver messages can carry hosts or tokens.
export const pushErrorCode = (message) => {
    const text = String(message || '')
    if (/time(d)?\s?out|abort|ETIMEDOUT/i.test(text)) return 'timeout'
    if (/\b40[13]\b|expired|re-?authenticate|credentials not loaded|unauthori[sz]ed/i.test(text)) return 'auth'
    const status = text.match(/\b([45]\d\d)\b/)
    if (status) return status[1]
    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket/i.test(text)) return 'network'
    return 'error'
}

// Null when the switch came from something else (a drift repair, an active URL outside the chain).
export function switchReason({ type, decision, members, activeIndex, targetIndex, chain, timeoutMs }) {
    if (type === 'recovery') {
        const member = members[targetIndex]
        if (decision?.reason !== 'recovered' || !member) return null
        return { addon: norm(chain[targetIndex]), checks: member.goodStreak }
    }
    const member = members[activeIndex]
    if (decision?.reason !== 'active-dead' || !member) return null
    const error = member.status ?? member.row ?? null
    return {
        addon: norm(chain[activeIndex]),
        misses: member.badStreak,
        error,
        ...(TIMEOUT_ROWS.has(member.row) && timeoutMs ? { timeoutMs } : {}),
    }
}

export function platformResults(connections, { okIds, states = null, outcomes = null, since = 0, failure = null }) {
    const ok = new Set(okIds || [])
    return (connections || []).filter(c => c && c.enabled !== false).map((c) => {
        if (ok.has(c.id)) return { id: c.id, platform: c.platform, ok: true }
        if (failure) return { id: c.id, platform: c.platform, ok: false, error: pushErrorCode(failure) }
        const outcome = outcomes?.[c.id]
        if (outcome?.error) return { id: c.id, platform: c.platform, ok: false, error: pushErrorCode(outcome.error) }
        const state = states?.[c.id]
        const error = state?.lastError && (state.lastErrorAt ?? 0) >= since ? pushErrorCode(state.lastError) : 'skipped'
        return { id: c.id, platform: c.platform, ok: false, error }
    })
}
