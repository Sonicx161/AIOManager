import { normalizeAddonUrl } from './addon-url.ts'
import { getRuleMissingConnection } from './autopilot-conflicts.ts'
import {
  AUTOPILOT_FIX_DETAIL, AUTOPILOT_SKIP_DETAIL, autopilotAttention, describeRuleError, ruleConflictDetail,
  type AutopilotRuleError, type AutopilotRuleFix, type AutopilotSafeMode, type AutopilotSkipReason,
} from './autopilot-freshness.ts'
import { readStabilization } from './autopilot-stabilization.ts'

export type OverviewState = 'need' | 'bk' | 'ok' | 'pause'

export const OVERVIEW_STATES: readonly OverviewState[] = ['need', 'bk', 'ok', 'pause']

export const OVERVIEW_STATE_LABEL: Record<OverviewState, string> = {
  need: 'Needs a look',
  bk: 'On backup',
  ok: 'Healthy',
  pause: 'Paused',
}

const SEVERITY: Record<OverviewState, number> = { need: 0, bk: 1, ok: 2, pause: 3 }
const FAILURES_BEFORE_DOWN = 2

export interface OverviewRule {
  id: string
  accountId: string
  name?: string
  priorityChain: string[]
  activeUrl?: string
  isActive: boolean
  isAutomatic?: boolean
  lastCheck?: Date | string | number | null
  createdAt?: number
  lastError?: AutopilotRuleError | null
  skipReason?: AutopilotSkipReason | null
  stabilization?: Record<string, number | { failures?: number; successes?: number; latencyMs?: number | null }>
  platform?: string
  connectionId?: string
}

export interface OverviewAccount {
  id: string
  name: string
  email?: string
  status?: string
  authKey?: string
  addons: ReadonlyArray<{ transportUrl: string; manifest?: { name?: string }; metadata?: { customName?: string } }>
  connections?: ReadonlyArray<{ id: string; platform: string; connectionType?: string; status?: string }>
}

export interface OverviewRow {
  accountId: string
  accountName: string
  state: OverviewState
  chain: string
  moreRules: number
  reason: string
  search: string
}

export interface OverviewInput {
  rules: ReadonlyArray<OverviewRule>
  accounts: ReadonlyArray<OverviewAccount>
  now: number
  budgetHit?: boolean
  firstSeen?: ReadonlyMap<string, number>
  safeMode?: AutopilotSafeMode | null
  maskName?: (name: string) => string
  platformLabel?: (platformId: string) => string
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function plural(n: number, unit: string) {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

function duration(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} min`
  if (ms < DAY) return plural(Math.round(ms / HOUR), 'hour')
  return plural(Math.round(ms / DAY), 'day')
}

function checkedAge(lastCheck: OverviewRule['lastCheck'], now: number): number | null {
  if (!lastCheck) return null
  const at = new Date(lastCheck).getTime()
  return Number.isFinite(at) ? Math.max(0, now - at) : null
}

/** Finds an addon's own name in one account: the exact transport URL first, the normalized form as fallback. */
function addonNamer(account: OverviewAccount) {
  const exact = new Map<string, string>()
  for (const addon of account.addons) exact.set(addon.transportUrl, addon.metadata?.customName || addon.manifest?.name || '')
  let normalized: Map<string, string> | null = null
  return (url: string | undefined): string => {
    if (!url) return ''
    const hit = exact.get(url)
    if (hit) return hit
    if (!normalized) {
      normalized = new Map()
      for (const addon of account.addons) normalized.set(normalizeAddonUrl(addon.transportUrl), addon.metadata?.customName || addon.manifest?.name || '')
    }
    return normalized.get(normalizeAddonUrl(url)) || ''
  }
}

interface Verdict {
  state: OverviewState
  reason: string
}

interface VerdictContext {
  account: OverviewAccount
  fix: AutopilotRuleFix | null
  now: number
  nameOf: (url: string | undefined) => string
  platformLabel: (platformId: string) => string
}

function reconnectReason(rule: OverviewRule, platformLabel: (platformId: string) => string) {
  return `${platformLabel(rule.platform || 'stremio')} login expired. Reconnect to keep failover running`
}

// Expiry belongs to the login the rule runs on, never to the account-level status of another platform's login.
function ruleLoginExpired(rule: OverviewRule, account: OverviewAccount): boolean {
  const bound = rule.connectionId ? (account.connections || []).find(connection => connection.id === rule.connectionId) : undefined
  return bound ? bound.status === 'expired' : account.status === 'expired'
}

function judge(rule: OverviewRule, { account, fix, now, nameOf, platformLabel }: VerdictContext): Verdict {
  if (!rule.isActive && !rule.lastError) return { state: 'pause', reason: 'Paused by you' }

  const missing = getRuleMissingConnection(rule, account)
  if (missing) return { state: 'need', reason: `${missing.label}. This rule has no login to run on` }

  if (fix) {
    const skip = rule.skipReason ? AUTOPILOT_SKIP_DETAIL[rule.skipReason] : null
    const age = checkedAge(rule.lastCheck, now)
    const reasons: Record<AutopilotRuleFix, string> = {
      reconnect: reconnectReason(rule, platformLabel),
      'edit-chain': 'An addon is in two rules here. Autopilot skips it',
      'retry-conflict': ruleConflictDetail(rule) || AUTOPILOT_FIX_DETAIL['retry-conflict'],
      restore: skip || AUTOPILOT_FIX_DETAIL.restore,
      'grant-access': skip || AUTOPILOT_FIX_DETAIL['grant-access'],
      resume: describeRuleError(rule.lastError) || AUTOPILOT_FIX_DETAIL.resume,
      remove: AUTOPILOT_FIX_DETAIL.remove,
      'safe-mode': AUTOPILOT_FIX_DETAIL['safe-mode'],
      refresh: skip || describeRuleError(rule.lastError) || (age === null ? 'Not checked yet' : `Not checked for ${duration(age)}`),
    }
    return { state: 'need', reason: reasons[fix] }
  }

  if (rule.isActive && ruleLoginExpired(rule, account)) return { state: 'need', reason: reconnectReason(rule, platformLabel) }
  if (!rule.isActive) return { state: 'pause', reason: 'Paused by you' }

  const chain = rule.priorityChain
  const primary = chain[0]
  const active = rule.activeUrl || primary
  const primaryNorm = normalizeAddonUrl(primary || '')
  const activeNorm = normalizeAddonUrl(active || '')
  const chainNorms = new Set(chain.map(normalizeAddonUrl))
  const failedOver = !!activeNorm && !!primaryNorm && activeNorm !== primaryNorm
  const primaryFailures = readStabilization(rule.stabilization, primary).failures
  const activeFailures = readStabilization(rule.stabilization, active).failures
  const allDown = chain.length > 0 && chain.every(url => readStabilization(rule.stabilization, url).failures >= FAILURES_BEFORE_DOWN)

  if (activeNorm && !chainNorms.has(activeNorm)) return { state: 'need', reason: 'Active addon is outside this priority chain' }
  if (activeFailures >= FAILURES_BEFORE_DOWN) {
    return { state: 'need', reason: allDown ? 'Nothing to switch to: every addon in the chain is down' : 'Active addon has repeated failures and no healthier fallback is active' }
  }
  if (primaryFailures >= FAILURES_BEFORE_DOWN && !failedOver) return { state: 'need', reason: 'Primary has repeated failures but is still marked active' }

  if (rule.isAutomatic === false) return { state: 'ok', reason: 'Manual mode, the current addon is kept' }

  if (failedOver) {
    const missed = primaryFailures > 0 ? `, ${nameOf(primary)} missed ${primaryFailures} checks` : ''
    return { state: 'bk', reason: `On ${nameOf(active)}${missed}` }
  }

  const age = checkedAge(rule.lastCheck, now)
  return { state: 'ok', reason: age === null ? 'Waiting for the first check' : age < MINUTE ? 'Watching, checked just now' : `Watching, checked ${duration(age)} ago` }
}

/** One row per account with rules: the account's most urgent rule decides the state and the reason. */
export function buildFailoverOverview({ rules, accounts, now, budgetHit, firstSeen, safeMode, maskName = name => name, platformLabel = id => id }: OverviewInput): OverviewRow[] {
  const accountById = new Map(accounts.map(account => [account.id, account]))
  const byAccount = new Map<string, OverviewRule[]>()
  for (const rule of rules) {
    if (!accountById.has(rule.accountId)) continue
    const list = byAccount.get(rule.accountId)
    if (list) list.push(rule)
    else byAccount.set(rule.accountId, [rule])
  }

  const fixes = new Map(autopilotAttention(rules.filter(rule => accountById.has(rule.accountId)), {
    now, budgetHit, firstSeen, safeMode, accountExists: id => accountById.has(id),
  }).map(({ id, fix }) => [id, fix]))

  const rows: OverviewRow[] = []
  for (const account of accounts) {
    const accountRules = byAccount.get(account.id)
    if (!accountRules) continue
    const rawName = addonNamer(account)
    const nameOf = (url: string | undefined) => maskName(rawName(url) || 'Unnamed addon')
    let best: { rule: OverviewRule; verdict: Verdict } | null = null
    for (const rule of accountRules) {
      const verdict = judge(rule, { account, fix: fixes.get(rule.id) ?? null, now, nameOf, platformLabel })
      if (!best || SEVERITY[verdict.state] < SEVERITY[best.verdict.state]) best = { rule, verdict }
    }
    if (!best) continue
    const chainNames = best.rule.priorityChain.map(nameOf)
    const searchable = [account.name, account.email, ...accountRules.flatMap(rule => [rule.name, ...rule.priorityChain.map(rawName)])]
    rows.push({
      accountId: account.id,
      accountName: maskName(account.name || account.email || 'Unnamed account'),
      state: best.verdict.state,
      chain: chainNames.join(', then '),
      moreRules: accountRules.length - 1,
      reason: best.verdict.reason,
      search: searchable.filter(Boolean).join('\n').toLowerCase(),
    })
  }
  return rows
}

export function countByState(rows: ReadonlyArray<OverviewRow>): Record<OverviewState, number> {
  const counts: Record<OverviewState, number> = { need: 0, bk: 0, ok: 0, pause: 0 }
  for (const row of rows) counts[row.state]++
  return counts
}

export function matchesSearch(row: OverviewRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || row.search.includes(q)
}
