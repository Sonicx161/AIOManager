import crypto from 'crypto'
import { PRIMARY_KEY } from '../keys.js'

// Shared by the Users screen (server/admin/reads.js) and the Dashboard log ring, so the two
// always produce the exact same labels. DB values never become object keys as-is: platforms
// map to a fixed list, anything unknown reads as `other`.
export const PLATFORMS = new Set(['stremio', 'nuvio', 'realstream', 'hydra', 'fusion', 'jellyfin', 'emby'])
export const platformKey = (v) => {
    const s = String(v ?? 'stremio').toLowerCase()
    return PLATFORMS.has(s) ? s : 'other'
}

// Stable, non-reversible label per account. The full account id never leaves the server.
export function accountHandle(id) {
    const key = crypto.createHash('sha256').update(`aiom-dashboard-handle|${PRIMARY_KEY || ''}`).digest()
    return 'acct-' + crypto.createHmac('sha256', key).update(String(id)).digest('hex').slice(0, 12)
}
