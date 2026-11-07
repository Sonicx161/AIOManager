import { autopilotDb as db } from '../write-tripwire.js'
import { decrypt } from '../../crypto.js'
import { FALLBACK_KEYS } from '../../keys.js'
import { resolveStremioConnectionIdentity } from '../../lib/stremio-credentials.js'
import { normalizeAddonUrl } from '../../utils/addon-url.js'
import { isExcludedFromDestinations } from '../../utils/addon-destinations.js'

// Read current owner-scoped policy for each write; caching could re-install
// a newly excluded addon during an otherwise valid Autopilot decision.
export const loadCanonicalDestinations = async (accountId, syncUser) => {
    const byUrl = new Map()
    // Owner-less legacy rule: only the unowned row may answer; any owned row for the account makes it ambiguous.
    if (!syncUser) {
        const owned = await db.get("SELECT sync_user FROM account_canonical_addons WHERE account_id = $1 AND COALESCE(sync_user, '') <> $2", [accountId, ''])
        if (owned) throw new Error('A rule owner is required to verify destination rules')
    }
    const row = await db.get('SELECT addon_list FROM account_canonical_addons WHERE account_id = $1 AND sync_user = $2', [accountId, syncUser || ''])
    if (!row?.addon_list) return byUrl
    const decrypted = decrypt(row.addon_list, FALLBACK_KEYS)
    if (!decrypted) throw new Error('Could not read the stored destination rules')
    const addons = JSON.parse(decrypted)
    if (!Array.isArray(addons)) throw new Error('Invalid stored addon collection')
    for (const addon of addons) {
        const url = normalizeAddonUrl(addon?.transportUrl || '').toLowerCase()
        if (url && addon?.destinations) byUrl.set(url, addon.destinations)
    }
    return byUrl
}

export const withCurrentDestinations = async (addons, accountId, syncUser) => {
    const policy = await loadCanonicalDestinations(accountId, syncUser)
    return (addons || []).map(addon => {
        const current = policy.get(normalizeAddonUrl(addon?.transportUrl || '').toLowerCase())
        if (current) return { ...addon, destinations: current }
        if (!addon?.destinations) return addon
        const { destinations, ...rest } = addon
        return rest
    })
}

export const resolveStremioConnectionId = async (accountId, syncUser, authKey, connectionId) => {
    const identity = await resolveStremioConnectionIdentity(accountId, syncUser, authKey, connectionId)
    return identity.ambiguous || identity.legacy ? undefined : identity.connectionId
}

export const stremioExcludedUrlsFromPolicy = (byUrl, connectionId) => {
    const out = new Set()
    for (const [url, destinations] of (byUrl || new Map())) {
        if (!connectionId && destinations?.excludedConnections?.length) throw new Error('Could not identify the Stremio login for its destination rules')
        if (isExcludedFromDestinations(destinations, { platform: 'stremio', connectionId })) out.add(url)
    }
    return out
}
