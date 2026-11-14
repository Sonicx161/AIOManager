import { autopilotDb as db } from '../write-tripwire.js'

// Caches key a rule on (id, updated_at), so every write moves it forward, even two writes in the same millisecond.
export const nextRuleVersion = (incoming, current = 'updated_at') =>
    `${db.type === 'postgres' ? 'GREATEST' : 'MAX'}(COALESCE(${current}, 0) + 1, ${incoming})`
