// Pure helpers for the account stat chips (update / changes / rules); also run under node --test.
import { normalizeAddonUrl } from '../../lib/addon-url.ts'
import type { AddonChangelogEntry } from '../../types/account.ts'

export const RECENT_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000
const RECENT_CHANGE_TTL_MS = 60_000

interface ChipAddon {
  transportUrl: string
  manifest?: { id?: string; name?: string; logo?: string }
  metadata?: { customName?: string; customLogo?: string }
}

interface ChipRule {
  id: string
  name?: string
  isActive: boolean
  priorityChain?: string[]
  activeUrl?: string
}

// Scanned once per changelog publication (60s TTL for the sliding window), not once per card.
let recentChangeCountsCache: { changelog: AddonChangelogEntry[]; builtAt: number; counts: Map<string, number> } | null = null
export function recentChangeCountsFor(changelog: AddonChangelogEntry[], now: number): Map<string, number> {
  if (recentChangeCountsCache && recentChangeCountsCache.changelog === changelog && now - recentChangeCountsCache.builtAt < RECENT_CHANGE_TTL_MS) {
    return recentChangeCountsCache.counts
  }
  const cutoff = now - RECENT_CHANGE_WINDOW_MS
  const counts = new Map<string, number>()
  for (const entry of changelog) {
    const ts = new Date(entry.timestamp).getTime()
    if (!Number.isFinite(ts) || ts <= cutoff) continue
    counts.set(entry.accountId, (counts.get(entry.accountId) || 0) + 1)
  }
  recentChangeCountsCache = { changelog, builtAt: now, counts }
  return counts
}

export function recentChangesFor(changelog: AddonChangelogEntry[], accountId: string, now: number): AddonChangelogEntry[] {
  const cutoff = now - RECENT_CHANGE_WINDOW_MS
  return changelog
    .filter(entry => {
      if (entry.accountId !== accountId) return false
      const ts = new Date(entry.timestamp).getTime()
      return Number.isFinite(ts) && ts > cutoff
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
}

// Same lookup as AddonChangelog: current addon by normalized URL, then by manifest id.
export function resolveChangelogAddon<T extends ChipAddon>(entry: AddonChangelogEntry, addons: readonly T[]): T | null {
  if (!entry.addonUrl && !entry.addonId) return null
  const entryUrl = entry.addonUrl ? normalizeAddonUrl(entry.addonUrl) : null
  if (entryUrl) {
    const byUrl = addons.find(addon => normalizeAddonUrl(addon.transportUrl) === entryUrl)
    if (byUrl) return byUrl
  }
  if (entry.addonId) {
    const byId = addons.find(addon => addon.manifest?.id === entry.addonId)
    if (byId) return byId
  }
  return null
}

export function changeActionLabel(action: AddonChangelogEntry['action']): string {
  if (action === 'installed') return 'Newly installed'
  if (action === 'removed') return 'Removed from account'
  if (action === 'replaced') return 'URL replaced'
  return 'Updated to latest'
}

// Always masked: first host label only, never protocol, path, query or credentials.
export function maskChangeUrl(url: string): string {
  try {
    const parts = new URL(url).hostname.split('.')
    const rest = parts.slice(1).map(p => '*'.repeat(p.length)).join('.')
    return `${parts[0]}${rest ? `.${rest}` : ''}/***`
  } catch {
    return '***'
  }
}

export interface ChangeEntryView {
  id: string
  name: string
  logo?: string
  action: AddonChangelogEntry['action']
  label: string
  maskedUrl: string | null
}

export function changeEntryView(entry: AddonChangelogEntry, addons: readonly ChipAddon[]): ChangeEntryView {
  const current = resolveChangelogAddon(entry, addons)
  const url = entry.action === 'replaced' ? entry.newAddonUrl || entry.addonUrl : undefined
  return {
    id: entry.id,
    name: current?.metadata?.customName || entry.addonName || current?.manifest?.name || 'Addon',
    logo: current?.metadata?.customLogo || entry.addonLogo,
    action: entry.action,
    label: changeActionLabel(entry.action),
    maskedUrl: url ? maskChangeUrl(url) : null,
  }
}

export function changeCountLabel(count: number): string {
  return `${count} change${count !== 1 ? 's' : ''} in the last 24h`
}

export interface RuleStatusView {
  id: string
  name: string
  failedOver: boolean
  detail: string
}

function addonNameFor(url: string | undefined, addons: readonly ChipAddon[]): string | null {
  if (!url) return null
  const target = normalizeAddonUrl(url)
  const match = addons.find(addon => normalizeAddonUrl(addon.transportUrl) === target)
  return match?.metadata?.customName || match?.manifest?.name || null
}

export function isRuleFailedOver(rule: ChipRule): boolean {
  return rule.activeUrl !== rule.priorityChain?.[0]
}

// Active rules only, failed-over first. Names come from the rule or its primary addon, never a URL.
export function ruleStatusViews(rules: readonly ChipRule[], addons: readonly ChipAddon[]): RuleStatusView[] {
  const views = rules.filter(rule => rule.isActive).map(rule => {
    const failedOver = isRuleFailedOver(rule)
    const backup = failedOver ? addonNameFor(rule.activeUrl, addons) : null
    return {
      id: rule.id,
      name: rule.name?.trim() || addonNameFor(rule.priorityChain?.[0], addons) || 'Autopilot rule',
      failedOver,
      detail: failedOver ? (backup ? `Failed over to ${backup}` : 'Failed over') : 'Healthy, on primary',
    }
  })
  return [...views.filter(v => v.failedOver), ...views.filter(v => !v.failedOver)]
}

export function ruleChipLabel(activeCount: number, failedOverCount: number): string {
  return failedOverCount > 0
    ? `${failedOverCount} rule${failedOverCount !== 1 ? 's' : ''} failed over`
    : `${activeCount} Autopilot rule${activeCount !== 1 ? 's' : ''} healthy`
}

export function addonCountLabel(count: number): string {
  return `${count} addon${count !== 1 ? 's' : ''}`
}

export function addonCountTooltip(count: number, protectedCount: number): string {
  return `${addonCountLabel(count)}${protectedCount > 0 ? `, ${protectedCount} protected` : ''}`
}

export function isSyncStale(lastSync: string | number | Date | null | undefined, now: number): boolean {
  if (lastSync === null || lastSync === undefined || lastSync === '') return false
  const ts = new Date(lastSync).getTime()
  return Number.isFinite(ts) && now - ts > RECENT_CHANGE_WINDOW_MS
}

export function tileLetter(name: string | undefined): string {
  return name?.trim()?.[0]?.toUpperCase() || '?'
}
