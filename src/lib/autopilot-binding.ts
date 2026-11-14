import { isSyncEligibleConnection } from '../types/connection.ts'
import type { Account } from '../types/account.ts'

export function resolveRuleSyncTarget(rule: { connectionId?: string; platform?: string; missingConnectionId?: string; skipReason?: string | null }, account: Account, hasStremioKey: boolean, selectNew = false): { connectionId?: string; connectionGeneration?: string; credentialType?: string; platform?: string } | null {
    if (rule.missingConnectionId || rule.skipReason === 'no_credentials') return null
    if (rule.connectionId) {
        const conn = account.connections?.find(c => c.id === rule.connectionId)
        return { connectionId: rule.connectionId, connectionGeneration: conn?.generation, credentialType: conn?.connectionType, platform: rule.platform || conn?.platform }
    }
    if ((rule.platform === 'stremio' || (!rule.platform && selectNew)) && hasStremioKey) return { platform: 'stremio' }
    if (rule.platform === 'stremio') return null
    if (!selectNew) return null
    const candidates = (account.connections || []).filter(c => c.enabled && isSyncEligibleConnection(c) && (!rule.platform || c.platform === rule.platform))
    const conn = candidates.length === 1 ? candidates[0] : undefined
    return conn ? { connectionId: conn.id, connectionGeneration: conn.generation, credentialType: conn.connectionType, platform: conn.platform } : null
}

export function serverRuleBinding(server: Record<string, unknown>, account: Account | undefined): { connectionId?: string; missingConnectionId?: string } | null {
    if (!Object.prototype.hasOwnProperty.call(server, 'connectionId')) return null
    const id = typeof server.connectionId === 'string' && server.connectionId ? server.connectionId : undefined
    if (!id) return { connectionId: undefined, missingConnectionId: undefined }
    const conn = account?.connections?.find(c => c.id === id)
    const generation = typeof server.connectionGeneration === 'string' ? server.connectionGeneration : undefined
    if (conn && (conn.generation || undefined) === generation) return { connectionId: id, missingConnectionId: undefined }
    if (account && id === `${account.id}:stremio` && !generation) return { connectionId: id, missingConnectionId: undefined }
    return { connectionId: undefined, missingConnectionId: id }
}
