import { normalizeAddonUrlForMatch } from './addon-url.ts'
import type { AddonDescriptor } from '../types/addon.ts'

interface ConflictRule {
  id: string
  accountId: string
  name?: string
  priorityChain: string[]
  connectionId?: string
  platform?: string
  isActive?: boolean
}

interface ConnectionAccount {
  id: string
  authKey?: string
  connections?: ReadonlyArray<{ id: string; platform: string; connectionType?: string }>
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
  const boundConnection = rule.connectionId ? connections.find(connection => connection.id === rule.connectionId) : null
  const hasStremio = connections.some(connection => connection.platform === 'stremio' && (!connection.connectionType || connection.connectionType === 'native')) || !!account.authKey && account.authKey.length > 60
  const hasLogin = rule.connectionId
    ? !!boundConnection || (rule.connectionId === `${account.id}:stremio` && hasStremio)
    : rule.platform && rule.platform !== 'stremio'
        ? connections.some(connection => connection.platform === rule.platform)
        : hasStremio
  if (hasLogin) return null
  const platform = rule.platform || 'stremio'
  const labels: Record<string, string> = { stremio: 'Stremio', nuvio: 'Nuvio', realstream: 'RealStream', hydra: 'Hydra', aiostreams: 'AIOStreams', aiometadata: 'AIOMetadata' }
  const label = `${labels[platform] || 'Connection'} login removed`
  return { platform, label, signature: JSON.stringify([rule.id, rule.name || '', rule.connectionId || '', platform, rule.isActive, rule.priorityChain, connections.map(connection => [connection.id, connection.platform]).sort(([a], [b]) => a.localeCompare(b))]) }
}

export async function ruleAddonReference(url: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeAddonUrlForMatch(url)))
  return `ad_${Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)}`
}
