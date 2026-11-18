import { normalizeAddonUrl } from '../../utils/addon-url.js'
import { urlRef } from './url-ref.js'

const BACKOFF_HOURS = [1, 4, 24]
const CONVERGENCE_MS = 5 * 60 * 1000
const INCIDENT_MEMORY_MS = BACKOFF_HOURS[BACKOFF_HOURS.length - 1] * 60 * 60 * 1000
const MAX_INCIDENTS = 16

export function createConflictState({ nowMs, maxEntries = 10000, ttlMs = 48 * 60 * 60 * 1000 }) {
    const entries = new Map()
    const accounts = new Map()
    const accountKey = (accountId, owner) => `${owner || ''}\0${accountId ?? ''}`
    const remove = id => {
        const entry = entries.get(id)
        if (!entry) return false
        entries.delete(id)
        const key = accountKey(entry.accountId, entry.owner)
        const ids = accounts.get(key)
        ids?.delete(id)
        if (ids?.size === 0) accounts.delete(key)
        return true
    }
    const normalized = urls => [...new Set((urls || []).map(normalizeAddonUrl).filter(Boolean))].sort()
    const touch = (rule) => {
        let entry = entries.get(rule.id)
        if (entry && (entry.owner !== rule.owner_sync_user || entry.accountId !== rule.account_id)) {
            remove(rule.id)
            entry = null
        }
        if (!entry) entry = { accountId: rule.account_id, owner: rule.owner_sync_user, scopes: new Map(), incidents: new Map(), step: -1, held: [], heldScopes: new Set(), retryAt: 0 }
        entry.lastSeen = nowMs()
        entries.delete(rule.id)
        entries.set(rule.id, entry)
        const key = accountKey(entry.accountId, entry.owner)
        if (!accounts.has(key)) accounts.set(key, new Set())
        accounts.get(key).add(rule.id)
        for (const [id, old] of entries) {
            if (entries.size <= maxEntries && nowMs() - old.lastSeen <= ttlMs) break
            remove(id)
        }
        return entry
    }
    const recordWrite = (rule, chain, target, scopes) => {
        if (!scopes?.length) return
        const entry = touch(rule)
        const members = normalized(chain)
        const active = normalizeAddonUrl(target)
        const expected = JSON.stringify([members, active])
        for (const scope of scopes) {
            const previous = entry.scopes.get(scope)
            const prior = previous && previous.expected !== expected
                ? { active: previous.active, members: previous.members, at: nowMs() } : null
            entry.scopes.set(scope, {
                expected, members, active, prior, version: (previous?.version || 0) + 1,
                observedVersion: previous?.expected === expected ? previous.observedVersion : 0,
                reverted: previous?.expected === expected ? previous.reverted : '',
                count: previous?.expected === expected ? previous.count : 0,
            })
            while (entry.scopes.size > 100) {
                const oldest = entry.scopes.keys().next().value
                entry.scopes.delete(oldest)
                entry.heldScopes.delete(oldest)
            }
        }
    }
    const observe = (rule, observations) => {
        const entry = entries.get(rule.id)
        if (!entry) return null
        if (entry.owner !== rule.owner_sync_user || entry.accountId !== rule.account_id) { remove(rule.id); return null }
        touch(rule)
        if (entry.retryAt > nowMs()) return getHold(rule.id)
        const newlyHeld = []
        const completeScopes = new Set((observations || []).filter(audit => audit.complete).map(audit => audit.scope))
        for (const audit of observations || []) {
            if (!audit.complete) {
                const failed = audit.scope ? [entry.scopes.get(audit.scope)]
                    : [...entry.scopes].filter(([scope]) => !completeScopes.has(scope)).map(([, state]) => state)
                for (const state of failed) if (state) { state.count = 0; state.reverted = '' }
                continue
            }
            const expected = entry.scopes.get(audit.scope)
            if (!expected || expected.active !== normalizeAddonUrl(audit.target)) continue
            const reverted = normalized(audit.reverted).filter(url => expected.members.includes(url))
            if (reverted.length === 0) {
                expected.count = 0
                expected.reverted = ''
                expected.observedVersion = expected.version
                if (entry.retryAt <= nowMs() && entry.heldScopes.has(audit.scope)) entry.heldScopes.delete(audit.scope)
                if (entry.retryAt <= nowMs() && entry.heldScopes.size === 0) {
                    if (entry.held.length) entry.incidents.clear()
                    entry.held = []
                    entry.retryAt = 0
                    entry.step = -1
                }
                continue
            }
            if (expected.observedVersion === expected.version) continue
            expected.observedVersion = expected.version
            const signature = JSON.stringify(reverted)
            expected.count = signature === expected.reverted ? expected.count + 1 : 1
            expected.reverted = signature
            if (expected.count >= 2) {
                newlyHeld.push(...reverted)
                entry.heldScopes.add(audit.scope)
            }
        }
        if (newlyHeld.length > 0) {
            entry.step = Math.min(entry.step + 1, BACKOFF_HOURS.length - 1)
            entry.held = normalized([...entry.held, ...newlyHeld])
            entry.retryAt = nowMs() + BACKOFF_HOURS[entry.step] * 60 * 60 * 1000
        }
        return getHold(rule.id)
    }
    const observeLive = (rule, scope, addons, target, ignoredUrls = []) => {
        const entry = entries.get(rule.id)
        const expected = entry?.scopes.get(scope)
        if (!expected) return null
        const ignored = new Set(normalized([...ignoredUrls]))
        const members = new Set(expected.members.filter(url => !ignored.has(url)))
        const proposed = normalizeAddonUrl(target || expected.active)
        const reverted = []
        for (const addon of Array.isArray(addons) ? addons : []) {
            const url = normalizeAddonUrl(addon?.transportUrl || addon?.url)
            if (!members.has(url)) continue
            const enabled = (addon?.flags?.enabled ?? addon?.enabled) !== false
            if (enabled !== (url === expected.active)) reverted.push(url)
        }
        const matches = active => (Array.isArray(addons) ? addons : []).every(addon => {
            const url = normalizeAddonUrl(addon?.transportUrl || addon?.url)
            return !members.has(url) || ((addon?.flags?.enabled ?? addon?.enabled) !== false) === (url === active)
        })
        if (matches(proposed)) return observe(rule, [{ scope, target: expected.active, reverted: [], complete: true }])
        const prior = expected.prior
        const priorMatch = prior && nowMs() - prior.at < CONVERGENCE_MS
            && JSON.stringify(prior.members.filter(url => !ignored.has(url))) === JSON.stringify([...members])
            && matches(prior.active)
        if (priorMatch) {
            expected.prior = null
            // Allow one old observation, but count it so a second reversal holds.
            expected.count = 0
            expected.reverted = ''
            return observe(rule, [{ scope, target: expected.active, reverted, complete: true }])
        }
        return observe(rule, [{ scope, target: expected.active, reverted, complete: true }])
    }
    const getHold = ruleId => {
        const entry = entries.get(ruleId)
        if (!entry?.held.length || entry.retryAt <= nowMs()) return null
        return { urls: [...entry.held], affectedRefs: entry.held.map(url => urlRef(url)), retryAt: entry.retryAt, retryHours: BACKOFF_HOURS[entry.step] }
    }
    const getAccountProtectedUrls = (accountId, owner) => {
        if (!owner) return []
        const urls = []
        for (const id of accounts.get(accountKey(accountId, owner)) || []) {
            const entry = entries.get(id)
            if (!entry) continue
            if (nowMs() - entry.lastSeen > ttlMs) { remove(id); continue }
            if (entry.retryAt > nowMs()) urls.push(...entry.held)
        }
        return normalized(urls)
    }
    const retry = ruleId => {
        const entry = entries.get(ruleId)
        if (!entry?.held.length) return false
        entry.retryAt = 0
        return true
    }
    const resetForIncident = (rule, target, downUrls) => {
        const entry = touch(rule)
        const identity = JSON.stringify([normalized(downUrls), normalizeAddonUrl(target)])
        // Remember incidents even before a hold, so the same failure cannot release it later.
        for (const [key, at] of entry.incidents) if (nowMs() - at > INCIDENT_MEMORY_MS) entry.incidents.delete(key)
        if (entry.incidents.has(identity)) return false
        entry.incidents.set(identity, nowMs())
        if (entry.incidents.size > MAX_INCIDENTS) entry.incidents.delete(entry.incidents.keys().next().value)
        if (!getHold(rule.id)) return false
        entry.retryAt = 0
        return true
    }
    const clear = ruleId => remove(ruleId)
    const clearAccount = accountId => {
        for (const [id, entry] of entries) if (entry.accountId === accountId) remove(id)
    }
    return { recordWrite, observe, observeLive, getHold, getAccountProtectedUrls, retry, resetForIncident, clear, clearAccount }
}
