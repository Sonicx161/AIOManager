import { normalizeAddonUrl } from '../utils/addon-url.js'

const normalizedUrls = (chain) => [...new Set((Array.isArray(chain) ? chain : [])
    .filter(url => typeof url === 'string')
    .map(normalizeAddonUrl)
    .filter(Boolean))]

// A shared manifest id does not identify one installation when configurations have
// different URLs. Only unambiguous identities can supplement exact URL matching.
function identityKeys(lists) {
    const byId = new Map()
    const idsByUrl = new Map()
    for (const list of lists) {
        for (const addon of Array.isArray(list) ? list : []) {
            const url = normalizeAddonUrl(addon?.transportUrl)
            const id = addon?.manifest?.id
            if (!url || typeof id !== 'string' || !id) continue
            if (!byId.has(id)) byId.set(id, new Set())
            byId.get(id).add(url)
            if (!idsByUrl.has(url)) idsByUrl.set(url, new Set())
            idsByUrl.get(url).add(id)
        }
    }
    return (url) => {
        const ids = idsByUrl.get(url)
        if (ids?.size !== 1) return null
        const id = ids.values().next().value
        return byId.get(id)?.size === 1 ? id : null
    }
}

export function findNewRuleOverlap({ priorityChain, previousChain = [], addonList = [], previousAddonList = [], siblings = [] }) {
    const idOf = identityKeys([addonList, previousAddonList, ...siblings.map(rule => rule.addonList)])
    const previous = new Set(normalizedUrls(previousChain))
    const proposed = normalizedUrls(priorityChain)
    for (const sibling of siblings) {
        const siblingUrls = new Set(normalizedUrls(sibling.priorityChain))
        const siblingIds = new Set([...siblingUrls].map(idOf).filter(Boolean))
        const shared = url => siblingUrls.has(url) || (idOf(url) !== null && siblingIds.has(idOf(url)))
        for (const url of proposed) {
            if (shared(url) && !previous.has(url)) {
                return { ruleId: sibling.id, url }
            }
        }
    }
    return null
}

export const RULE_OVERLAP_MESSAGE = 'This addon is already in another Autopilot rule. Remove it from one rule first.'
