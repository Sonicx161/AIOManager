export type AutopilotSkipReason = 'no_valid_chain' | 'no_credentials' | 'not_on_server'

export type AutopilotFreshness = 'fresh' | 'stale' | 'unverified' | 'not-monitored'

interface FreshnessInput {
  ageMs: number | null
  staleMs: number
  statePullFailed: boolean
  skipReason?: AutopilotSkipReason | null
}

export const AUTOPILOT_SKIP_DETAIL: Record<AutopilotSkipReason, string> = {
  no_valid_chain: 'Not monitored: no valid chain. Every URL in the priority chain is unreachable or unsafe for the server.',
  no_credentials: 'Not monitored: the server has no credentials for this rule. Re-save the rule to restore monitoring.',
  not_on_server: 'Not monitored: the server has no copy of this rule. Restore it to resume checks.',
}

export function resolveAutopilotFreshness({ ageMs, staleMs, statePullFailed, skipReason }: FreshnessInput): AutopilotFreshness {
  if (skipReason && !statePullFailed) return 'not-monitored'
  if (statePullFailed && (ageMs === null || ageMs > staleMs)) return 'unverified'
  if (ageMs !== null && ageMs > staleMs) return 'stale'
  return 'fresh'
}

export interface AutopilotRuleError {
  code: string
  message: string
  affectedRefs?: string[]
  retryAt?: number
  retryHours?: number
}

export interface AutopilotSafeMode {
  since: number | null
  reason: string
}

export const AUTOPILOT_SAFE_MODE_DETAIL = 'Autopilot paused to protect your data. Your addons are unchanged.'

const asTime = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const at = new Date(value).getTime()
    if (Number.isFinite(at)) return at
  }
  return null
}

export function readSafeMode(value: unknown): AutopilotSafeMode | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  return { since: asTime(v.since), reason: typeof v.reason === 'string' ? v.reason : '' }
}

export function readRuleError(value: unknown): AutopilotRuleError | null {
  if (!value) return null
  if (typeof value === 'string') return { code: '', message: value }
  if (typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const code = typeof v.code === 'string' ? v.code : ''
  const message = typeof v.message === 'string' ? v.message : ''
  if (!code && !message) return null
  const affectedRefs = Array.isArray(v.affectedRefs)
    ? [...new Set(v.affectedRefs.filter((ref): ref is string => typeof ref === 'string' && /^ad_[a-f0-9]{16}$/i.test(ref)))].slice(0, 100)
    : []
  return {
    code,
    message,
    ...(affectedRefs.length ? { affectedRefs } : {}),
    ...(typeof v.retryAt === 'number' && Number.isFinite(v.retryAt) && v.retryAt >= 0 ? { retryAt: v.retryAt } : {}),
    ...(typeof v.retryHours === 'number' && [1, 4, 24].includes(v.retryHours) ? { retryHours: v.retryHours } : {}),
  }
}

export function ruleConflictDetail(rule: { lastError?: AutopilotRuleError | null }, addonName?: string): string | null {
  if (rule.lastError?.code === 'chain_overlap') {
    return `${addonName || 'An addon'} is in two Autopilot rules. Remove it from one.`
  }
  if (rule.lastError?.code === 'contested_by_other_writer') {
    return `Another app or workspace keeps changing these addons. Autopilot paused enforcing them and will retry in ${rule.lastError.retryHours || 1} h.`
  }
  return null
}

export function describeRuleError(error: AutopilotRuleError | null | undefined): string | null {
  if (!error) return null
  const text = (error.message || error.code).trim()
  if (!text) return null
  const short = text.length > 80 ? `${text.slice(0, 77)}...` : text
  return `Last check failed: ${short}`
}

export type AutopilotChipStatus = 'Offline' | 'Standby' | 'Live' | 'Paused' | 'Stale' | 'Failing'

export const isAutopilotWarning = (status: AutopilotChipStatus): boolean => status === 'Stale' || status === 'Failing'

interface ChipRule {
  id?: string
  isActive: boolean
  lastCheck?: Date | string | number | null
  createdAt?: number
  lastError?: AutopilotRuleError | null
  skipReason?: AutopilotSkipReason | null
}

interface ChipInput {
  isServerLive: boolean
  hasRules: boolean
  rules: ReadonlyArray<ChipRule>
  budgetHit?: boolean
  now: number
  safeMode?: AutopilotSafeMode | null
  firstSeen?: ReadonlyMap<string, number>
  /** True when the last /api/autopilot/states pull could not be reached: local lastCheck ages are unverified. */
  statePullFailed?: boolean
  /** True when the last automatic pulse could not complete a check: independent unreachable evidence. */
  pulseUnreachable?: boolean
  /** False until this session's first complete successful states pull: persisted lastCheck ages are unconfirmed. */
  statesPulled?: boolean
}

/** Shown instead of "Autopilot server is offline." when the client itself could not reach the server. */
export const AUTOPILOT_UNREACHABLE_DETAIL = "Can't reach the server to check Autopilot."

/** Shown when the server answered but only some rule states arrived; claims nothing about the server being up or down. */
export const AUTOPILOT_PARTIAL_DETAIL = "Couldn't load every rule's status."

/** The server operator turned Autopilot checks off (AUTOPILOT_WORKER); rules are stored but nothing runs. */
export const AUTOPILOT_WORKER_OFF_TITLE = 'Checks are turned off on this server'
export const AUTOPILOT_WORKER_OFF_DETAIL = 'Rules are saved and will run when the server operator turns Autopilot checks on.'

/** Pulse bodies never sent the field; only an explicit false says the worker is off. */
export function readWorkerEnabledFlag(value: unknown): boolean {
  return value !== false
}

export const AUTOPILOT_CHIP_MIN_STALE_MS = 10 * 60 * 1000
export const AUTOPILOT_UNCHECKED_GRACE_MS = 10 * 60 * 1000

/** Remembers when the chip first saw each never-checked rule that has no created time. */
export function recordFirstSeen(seen: Map<string, number>, rules: ReadonlyArray<ChipRule>, now: number) {
  for (const rule of rules) {
    if (rule.id && rule.isActive && !rule.lastCheck && !rule.createdAt && !seen.has(rule.id)) seen.set(rule.id, now)
  }
}

function chipStaleMs(budgetHit?: boolean): number {
  return Math.max(AUTOPILOT_CHIP_MIN_STALE_MS, budgetHit ? 60 * 60 * 1000 : 15 * 60 * 1000)
}

function ruleStaleness(rule: ChipRule, now: number, staleMs: number, firstSeen?: ReadonlyMap<string, number>): 'skipped' | 'stale' | 'unchecked' | null {
  if (rule.skipReason) return 'skipped'
  const at = rule.lastCheck ? new Date(rule.lastCheck).getTime() : Number.NaN
  if (Number.isFinite(at)) return now - at > staleMs ? 'stale' : null
  const since = rule.createdAt ?? (rule.id ? firstSeen?.get(rule.id) : undefined)
  return since !== undefined && now - since > AUTOPILOT_UNCHECKED_GRACE_MS ? 'unchecked' : null
}

export function resolveAutopilotChip({ isServerLive, hasRules, rules, budgetHit, now, safeMode, firstSeen, statePullFailed, pulseUnreachable, statesPulled }: ChipInput): {
  status: AutopilotChipStatus
  lastCheckedAt: number | null
  activeCount: number
  staleCount: number
  uncheckedCount: number
  errorCount: number
  notMonitoredCount: number
  safeMode: AutopilotSafeMode | null
} {
  const active = rules.filter(r => r.isActive)
  let newest: number | null = null
  for (const rule of active) {
    if (!rule.lastCheck) continue
    const at = new Date(rule.lastCheck).getTime()
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at
  }
  const base = safeMode ? 'Paused' : !isServerLive ? 'Offline' : !hasRules ? 'Standby' : active.length > 0 ? 'Live' : 'Paused'
  const staleMs = chipStaleMs(budgetHit)
  let staleCount = 0
  let uncheckedCount = 0
  let errorCount = 0
  let notMonitoredCount = 0
  if (base === 'Live') {
    for (const rule of active) {
      if (rule.lastError) errorCount++
      const stale = ruleStaleness(rule, now, staleMs, firstSeen)
      if (stale === 'skipped') notMonitoredCount++
      if (stale === 'unchecked') uncheckedCount++
      if (stale) staleCount++
    }
  }
  // Before this session's first successful pull, every staleness category is persisted
  // history, not a fresh verdict: never alarm on it. After a failed pull, stale-looking
  // rules are unverifiable, so never blame the server for not checking them.
  const confirmedStaleCount = statesPulled === false ? 0 : staleCount
  const unreachable = !safeMode && staleCount > 0 && (statePullFailed === true || pulseUnreachable === true)
  return {
    status: unreachable ? 'Offline' : confirmedStaleCount > 0 ? 'Stale' : errorCount > 0 ? 'Failing' : base,
    lastCheckedAt: newest,
    activeCount: active.length,
    staleCount: confirmedStaleCount,
    uncheckedCount,
    errorCount,
    notMonitoredCount,
    safeMode: safeMode ?? null,
  }
}

export const NOT_ON_SERVER_GRACE_MS = 2 * 60 * 1000

/** Local rules a complete state pull did not return: the server has no copy, so nothing checks them. */
export function rulesMissingOnServer(
  rules: ReadonlyArray<{ id: string; accountId: string; createdAt?: number }>,
  requestedAccountIds: ReadonlySet<string>,
  seenRuleIds: ReadonlySet<string>,
  now: number,
  pendingRuleIds: ReadonlySet<string> = new Set(),
): Set<string> {
  const missing = new Set<string>()
  for (const rule of rules) {
    if (!requestedAccountIds.has(rule.accountId) || seenRuleIds.has(rule.id) || pendingRuleIds.has(rule.id)) continue
    if (rule.createdAt !== undefined && now - rule.createdAt < NOT_ON_SERVER_GRACE_MS) continue
    missing.add(rule.id)
  }
  return missing
}

export const AUTOPILOT_SERVER_LIVE_MS = 180_000

export function isAutopilotServerLive(lastWorkerRun: Date | string | number | null | undefined, now: number): boolean {
  if (!lastWorkerRun) return false
  const at = new Date(lastWorkerRun).getTime()
  return Number.isFinite(at) && now - at < AUTOPILOT_SERVER_LIVE_MS
}

/** Which bulk actions apply: Resume only when something is paused, Pause only when something runs. */
export function autopilotBulkActions(rules: ReadonlyArray<{ isActive: boolean }>): { resume: boolean; pause: boolean } {
  const enabled = rules.filter(r => r.isActive).length
  return { resume: enabled < rules.length, pause: enabled > 0 }
}

export type AutopilotRuleFix = 'restore' | 'remove' | 'grant-access' | 'reconnect' | 'resume' | 'safe-mode' | 'refresh' | 'edit-chain' | 'retry-conflict'

const AUTH_EXPIRED_TEXT = /\b(401|403)\b|unauthori[sz]ed|session does not exist|session expired|auth key expired|invalid (auth|token|session)/i

export function isAuthExpiredError(error: AutopilotRuleError | null | undefined): boolean {
  if (!error) return false
  return error.code === 'auth_expired' || AUTH_EXPIRED_TEXT.test(`${error.code} ${error.message}`)
}

interface FixRule {
  isActive: boolean
  skipReason?: AutopilotSkipReason | null
  lastError?: AutopilotRuleError | null
}

/** One action per rule, picked from the server's reason. null when nothing needs fixing. */
export function resolveRuleFix(rule: FixRule, { accountExists, safeMode, stale = false }: { accountExists: boolean; safeMode?: AutopilotSafeMode | null; stale?: boolean }): AutopilotRuleFix | null {
  if (!accountExists) return 'remove'
  if (rule.skipReason === 'not_on_server') return 'restore'
  if (safeMode) return 'safe-mode'
  if (isAuthExpiredError(rule.lastError)) return 'reconnect'
  if (rule.skipReason === 'no_credentials' || rule.lastError?.code === 'decrypt_failed') return 'grant-access'
  if (!rule.isActive) return 'resume'
  if (rule.lastError?.code === 'chain_overlap') return 'edit-chain'
  if (rule.lastError?.code === 'contested_by_other_writer') return 'retry-conflict'
  if (rule.skipReason || rule.lastError || stale) return 'refresh'
  return null
}

export const AUTOPILOT_FIX_LABEL: Record<AutopilotRuleFix, string> = {
  restore: 'Restore on server',
  remove: 'Remove',
  'grant-access': 'Grant access',
  reconnect: 'Reconnect',
  resume: 'Resume',
  'safe-mode': '',
  refresh: 'Refresh status',
  'edit-chain': 'Edit Chain',
  'retry-conflict': 'Retry Now',
}

export const AUTOPILOT_FIX_DETAIL: Record<AutopilotRuleFix, string> = {
  restore: 'The server has no copy of this rule.',
  remove: 'The account for this rule is gone.',
  'grant-access': 'Autopilot needs access to this account.',
  reconnect: 'The login for this account expired.',
  resume: 'This rule is paused.',
  'safe-mode': AUTOPILOT_SAFE_MODE_DETAIL,
  refresh: 'Not checked recently.',
  'edit-chain': 'An addon is in two Autopilot rules. Remove it from one.',
  'retry-conflict': 'Another app or workspace keeps changing these addons. Autopilot paused enforcing them.',
}

interface AttentionRule extends ChipRule, FixRule {
  id: string
  accountId: string
}

/** Rules the Autopilot popover lists with a fix. Paused rules count only when the server paused them (an error). */
export function autopilotAttention(
  rules: ReadonlyArray<AttentionRule>,
  { now, budgetHit, firstSeen, accountExists, safeMode }: { now: number; budgetHit?: boolean; firstSeen?: ReadonlyMap<string, number>; accountExists: (accountId: string) => boolean; safeMode?: AutopilotSafeMode | null },
): Array<{ id: string; fix: AutopilotRuleFix }> {
  if (safeMode) return []
  const staleMs = chipStaleMs(budgetHit)
  const out: Array<{ id: string; fix: AutopilotRuleFix }> = []
  for (const rule of rules) {
    const exists = accountExists(rule.accountId)
    if (exists && !rule.isActive && !rule.lastError) continue
    const stale = rule.isActive && ruleStaleness(rule, now, staleMs, firstSeen) !== null
    const fix = resolveRuleFix(rule, { accountExists: exists, stale })
    if (fix) out.push({ id: rule.id, fix })
  }
  return out
}

export interface RestoreSession {
  attempted: Set<string>
  failures: number
  blockedUntil: number
}

export interface RuleBatchOutcome {
  restored: string[]
  failed: Record<string, string>
  rateLimited: { retryAfterMs: number; message: string } | null
}

export const createRestoreSession = (): RestoreSession => ({ attempted: new Set(), failures: 0, blockedUntil: 0 })

export const RESTORE_RATE_LIMIT_MESSAGE = 'Too many Autopilot changes right now. Try again later.'
const RESTORE_BACKOFF_BASE_MS = 60_000
const RESTORE_BACKOFF_MAX_MS = 30 * 60_000
const RESTORE_BATCH_MAX = 100

export const restoreBackoffMs = (failures: number): number =>
  Math.min(RESTORE_BACKOFF_MAX_MS, RESTORE_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1))

interface RestoreCandidate {
  id: string
  accountId: string
  skipReason?: AutopilotSkipReason | null
}

/** A rule's account is live when it is listed and not tombstoned after its last restore. */
export function liveAccountCheck(
  accountIds: Iterable<string>,
  deleted: Readonly<Record<string, number>> = {},
  restored: Readonly<Record<string, number>> = {},
): (accountId: string) => boolean {
  const listed = new Set(accountIds)
  return id => listed.has(id) && !(Object.hasOwn(deleted, id) && deleted[id] >= (restored[id] ?? 0))
}

/** Rules lost on the server that this session may still restore on its own. */
export function pickAutoRestore(
  rules: ReadonlyArray<RestoreCandidate>,
  accountExists: (accountId: string) => boolean,
  deletedRuleIds: ReadonlySet<string>,
  session: RestoreSession,
  now: number,
): string[] {
  if (now < session.blockedUntil) return []
  return rules
    .filter(r => r.skipReason === 'not_on_server' && accountExists(r.accountId) && !deletedRuleIds.has(r.id) && !session.attempted.has(r.id))
    .map(r => r.id)
}

/** Reads a sync-batch reply: per-rule results, a whole-request 429, or a plain failure. */
export function readRuleBatchResponse(status: number, body: unknown, sentIds: readonly string[]): RuleBatchOutcome {
  const data = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const error = typeof data.error === 'string' && data.error ? data.error : ''
  const retryAfter = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : RESTORE_BACKOFF_BASE_MS)
  if (status === 429) {
    return { restored: [], failed: Object.fromEntries(sentIds.map(id => [id, RESTORE_RATE_LIMIT_MESSAGE])), rateLimited: { retryAfterMs: retryAfter(data.retryAfterMs), message: RESTORE_RATE_LIMIT_MESSAGE } }
  }
  if (status < 200 || status >= 300) {
    const message = error || `The server returned ${status}.`
    return { restored: [], failed: Object.fromEntries(sentIds.map(id => [id, message])), rateLimited: null }
  }
  const results = Array.isArray(data.results) ? data.results as Array<Record<string, unknown>> : []
  const byId = new Map(results.filter(r => r && typeof r.id === 'string').map(r => [r.id as string, r]))
  const outcome: RuleBatchOutcome = { restored: [], failed: {}, rateLimited: null }
  for (const id of sentIds) {
    const r = byId.get(id)
    if (r?.ok === true) { outcome.restored.push(id); continue }
    if (r && r.retryAfterMs !== undefined) {
      outcome.rateLimited = { retryAfterMs: retryAfter(r.retryAfterMs), message: RESTORE_RATE_LIMIT_MESSAGE }
      outcome.failed[id] = RESTORE_RATE_LIMIT_MESSAGE
      continue
    }
    outcome.failed[id] = typeof r?.error === 'string' && r.error ? r.error : 'The server did not take this rule.'
  }
  return outcome
}

/** Sends the picked rules in batches; a 429 stops it and blocks the session until the server's retry time. */
export async function runAutoRestore(
  ids: readonly string[],
  session: RestoreSession,
  now: number,
  send: (ids: string[]) => Promise<RuleBatchOutcome>,
): Promise<RuleBatchOutcome> {
  const total: RuleBatchOutcome = { restored: [], failed: {}, rateLimited: null }
  for (let i = 0; i < ids.length; i += RESTORE_BATCH_MAX) {
    const chunk = ids.slice(i, i + RESTORE_BATCH_MAX)
    for (const id of chunk) session.attempted.add(id)
    const outcome = await send(chunk)
    total.restored.push(...outcome.restored)
    Object.assign(total.failed, outcome.failed)
    if (outcome.rateLimited) {
      total.rateLimited = outcome.rateLimited
      session.blockedUntil = now + outcome.rateLimited.retryAfterMs
      return total
    }
  }
  if (Object.keys(total.failed).length > 0) {
    session.failures++
    session.blockedUntil = now + restoreBackoffMs(session.failures)
  } else if (total.restored.length > 0) {
    session.failures = 0
  }
  return total
}

export function restoredToastCopy(names: ReadonlyArray<string | undefined>): { title: string; description: string } {
  if (names.length === 1) return { title: `Restored ${names[0]?.trim() || 'your Autopilot rule'} on the server.`, description: 'Autopilot can watch it again.' }
  return { title: `Restored ${names.length} rules on the server.`, description: 'Autopilot can watch them again.' }
}
