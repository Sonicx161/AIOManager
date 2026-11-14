import { normalizeAddonUrlForMatch } from './addon-url.ts'
import type { AddonDescriptor } from '../types/addon.ts'

interface ConflictRule {
  id: string
  accountId: string
  name?: string
  priorityChain: string[]
  connectionId?: string
  missingConnectionId?: string
  skipReason?: string | null
  platform?: string
  isActive?: boolean
}

interface ConnectionAccount {
  id: string
  authKey?: string
  connections?: ReadonlyArray<{ id: string; platform: string; connectionType?: string; enabled?: boolean }>
}

export interface TakenRuleAddon {
  ruleId: string
  ruleName: string
  count: number
}

export const ruleDisplayName = (rule: Pick<ConflictRule, 'id' | 'name'>): string => rule.name || `Rule ${rule.id.slice(0, 8)}`

export function getTakenRuleAddons(accountId: string, rules: ReadonlyArray<ConflictRule>, _addons: ReadonlyArray<AddonDescriptor>, ownRuleId?: string): Map<string, TakenRuleAddon> {
  const taken = new Map<string, TakenRuleAddon>()
  for (const rule of rules) {
    if (rule.accountId !== accountId || rule.id === ownRuleId) continue
    const seen = new Set<string>()
    for (const raw of rule.priorityChain) {
      const url = normalizeAddonUrlForMatch(raw)
      if (!url || seen.has(url)) continue
      seen.add(url)
      const prior = taken.get(url)
      taken.set(url, prior ? { ...prior, count: prior.count + 1 } : { ruleId: rule.id, ruleName: ruleDisplayName(rule), count: 1 })
    }
  }
  return taken
}

export function findRuleOverlaps(rule: ConflictRule, rules: ReadonlyArray<ConflictRule>, addons: ReadonlyArray<AddonDescriptor>) {
  const taken = getTakenRuleAddons(rule.accountId, rules, addons, rule.id)
  return rule.priorityChain.flatMap(url => {
    const conflict = taken.get(normalizeAddonUrlForMatch(url))
    return conflict ? [{ url, ...conflict }] : []
  })
}

export function growsRuleOverlap(chain: ReadonlyArray<string>, original: ReadonlyArray<string>, taken: ReadonlyMap<string, TakenRuleAddon>): boolean {
  const existing = new Set(original.map(normalizeAddonUrlForMatch).filter(url => taken.has(url)))
  return chain.some(raw => {
    const url = normalizeAddonUrlForMatch(raw)
    return taken.has(url) && !existing.has(url)
  })
}

export function getRuleMissingConnection(rule: ConflictRule, account: ConnectionAccount | undefined): { platform: string; label: string; signature: string } | null {
  if (!account) return null
  const connections = account.connections || []
  const usable = connections.filter(connection => connection.enabled !== false && connection.connectionType !== 'hydra-inbound' && connection.platform !== 'jellyfin')
  const boundConnection = rule.connectionId ? usable.find(connection => connection.id === rule.connectionId) : null
  const hasStremio = usable.some(connection => connection.platform === 'stremio' && (!connection.connectionType || connection.connectionType === 'native')) || !!account.authKey && account.authKey.length > 60
  const platforms = [...new Set(usable.map(connection => connection.platform))]
  const platform = rule.platform || boundConnection?.platform || (!rule.connectionId ? (hasStremio && platforms.length === 0 ? 'stremio' : platforms.length === 1 ? platforms[0] : '') : '')
  const hasLogin = platform === 'stremio' ? hasStremio : platform ? usable.some(connection => connection.platform === platform) : hasStremio || usable.length > 0
  const labels: Record<string, string> = { stremio: 'Stremio', nuvio: 'Nuvio', realstream: 'RealStream', hydra: 'Hydra', aiostreams: 'AIOStreams', aiometadata: 'AIOMetadata' }
  const boundAvailable = rule.skipReason !== 'no_credentials' && !rule.missingConnectionId && (rule.connectionId ? !!boundConnection || (rule.connectionId === `${account.id}:stremio` && hasStremio) : platform === 'stremio' && hasStremio)
  if (hasLogin && boundAvailable) return null
  const label = `${labels[platform] || 'Connection'} login ${rule.missingConnectionId || !hasLogin ? 'removed' : 'unavailable'}`
  return { platform, label, signature: JSON.stringify([rule.id, rule.name || '', rule.connectionId || '', rule.missingConnectionId || '', platform, rule.isActive, rule.priorityChain, connections.map(connection => [connection.id, connection.platform, connection.connectionType || '', String(connection.enabled !== false)]).sort(([a], [b]) => a.localeCompare(b))]) }
}

export async function ruleAddonReference(url: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeAddonUrlForMatch(url)))
  return `ad_${Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)}`
}
