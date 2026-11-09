import { maskSecretUrl } from './mask-secret-url.ts'

export type InboxVariant = 'default' | 'destructive' | 'warning'

export interface InboxEntry {
  id: string
  title: string
  description: string
  variant: InboxVariant
  at: number
  read: boolean
  count: number
  href?: string
  accountId?: string
  /** Set by sign-in fix notices: the inbox offers a "Sign in to X" action for these entries. */
  actionHint?: 'signin'
  actionTarget?: { connectionId: string; platform: string }
}

export interface InboxCandidate {
  id: string
  title: string
  description?: unknown
  variant?: InboxVariant
  href?: string
  accountId?: string
  history?: boolean
  actionHint?: 'signin'
  actionTarget?: { connectionId: string; platform: string }
}

export const INBOX_CAP = 50

// A sign-in action target must name a real connection id and a supported
// platform id; anything else (a token-bearing URL, free text) is dropped so it
// can never be stored or replayed as a connection reference.
const SAFE_CONNECTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const SIGNIN_PLATFORM_IDS = new Set(['stremio', 'nuvio', 'realstream', 'jellyfin', 'hydra-outbound'])

export function sanitizeActionTarget(v: unknown): { connectionId: string; platform: string } | undefined {
  const t = v as { connectionId?: unknown; platform?: unknown } | null
  if (!t || typeof t.connectionId !== 'string' || typeof t.platform !== 'string') return undefined
  if (!SAFE_CONNECTION_ID.test(t.connectionId) || !SIGNIN_PLATFORM_IDS.has(t.platform)) return undefined
  return { connectionId: t.connectionId, platform: t.platform }
}

const ROUTINE_TITLE = /^(welcome back|signed in|login successful|logged out|signed out|sign in to continue)$|copied|\.\.\.\s*$/i
const MEANINGFUL = /sync|autopilot|failover|rule|deploy|install|delet|remov|clear|wip|purg|restor|backup|import|export|mirror|migrat|revoked|pushed|session refreshed/i

const URL_IN_TEXT = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi
const SENSITIVE_LOOKAHEAD = String.raw`(?=[\w.-]*(?:key|token|secret|pass|auth|sig|jwt|cred|session))`
const PAIR = new RegExp(String.raw`(?<![\w.-])${SENSITIVE_LOOKAHEAD}([\w.-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s,;&"']+)`, 'gi')
const JSON_PAIR = new RegExp(String.raw`(["'])${SENSITIVE_LOOKAHEAD}([\w.-]+)\1\s*:\s*("[^"]*"|'[^']*')`, 'gi')
const BEARER = /\bBearer\s+[\w.~+/=-]+/gi
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const JWT_LIKE = /(?<![\w-])eyJ[\w-]{5,}\.[\w-]+\.[\w-]+/g
const KEYWORD_BLOB = /\b(?:key|token|config|auth|secret|password|bearer)\b[^\w]{0,4}[A-Za-z0-9+/_=-]{20,}/gi
const CONTEXT_BLOB = /(?:\/|[?&][\w.-]{1,32}=)[A-Za-z0-9+_=-]{24,}/g
const LONG_RUN = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{64,}/g
const CAMEL_LETTERS = /[A-Za-z]{20,}/g
const WORD = /[A-Z]?[a-z]{3,}/g
const TRAILING_PUNCT = new Set('.,;:!?)]}')
const PERCENT_RUN = /(?:%[0-9a-f]{2})+/gi
const JSON_ESCAPE = /\\(?:u([0-9a-f]{4})|([/"\\]))/gi

function decodeEscapes(text: string): string {
  let out = text.replace(JSON_ESCAPE, (_m, hex: string | undefined, ch: string | undefined) => (hex ? String.fromCharCode(parseInt(hex, 16)) : (ch as string)))
  for (let i = 0; i < 3; i++) {
    const next = out.replace(PERCENT_RUN, run => {
      try { return decodeURIComponent(run) } catch { return run }
    })
    if (next === out) break
    out = next
  }
  return out
}

function hasCamelWords(value: string): boolean {
  for (const run of value.matchAll(CAMEL_LETTERS)) {
    let covered = 0
    for (const word of run[0].matchAll(WORD)) covered += word[0].length
    if (covered >= run[0].length * 0.8) return true
  }
  return false
}

function redactCredentialRun(value: string): string {
  return /\d/.test(value) && !hasCamelWords(value) ? '[token]' : value
}

function looksLikeBlob(value: string): boolean {
  const digits = value.match(/\d/g)?.length ?? 0
  if (digits < 3 || !/[a-z]/.test(value) || !/[A-Z]/.test(value)) return false
  const separators = value.match(/[-_]/g)?.length ?? 0
  if (separators >= 5) return false
  return !hasCamelWords(value)
}

function stripUrl(raw: string): string {
  let end = raw.length
  while (end > 0 && TRAILING_PUNCT.has(raw[end - 1])) end--
  const trail = raw.slice(end)
  const core = raw.slice(0, end)
  try {
    const u = new URL(core)
    return `${maskSecretUrl(`${u.protocol}//${u.host}${u.pathname}`)}${trail}`
  } catch {
    return `[link]${trail}`
  }
}

/** Removes credentials, URL query/fragment/userinfo and emails from free text before it is stored. */
export function sanitizeInboxText(text: string): string {
  return decodeEscapes(text)
    .replace(URL_IN_TEXT, stripUrl)
    .replace(BEARER, 'Bearer ***')
    .replace(JSON_PAIR, '$1$2$1: "***"')
    .replace(PAIR, '$1=***')
    .replace(JWT_LIKE, '[token]')
    .replace(KEYWORD_BLOB, m => m.replace(/[A-Za-z0-9+/_=-]{20,}$/, redactCredentialRun))
    .replace(CONTEXT_BLOB, m => m.replace(/[A-Za-z0-9+_=-]{24,}$/, redactCredentialRun))
    .replace(LONG_RUN, m => (looksLikeBlob(m) ? '[token]' : m))
    .replace(EMAIL, '[email]')
}

/** Only internal routes survive; query and fragment are dropped. */
export function sanitizeInboxHref(href: unknown): string | undefined {
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//') || href.startsWith('/\\')) return undefined
  const path = href.split(/[?#]/)[0].replace(EMAIL, '[email]')
  return path || undefined
}

export function describeText(description: unknown): string {
  if (typeof description === 'string') return description
  if (typeof description === 'number') return String(description)
  return ''
}

export function isRecordable(toast: InboxCandidate): boolean {
  if (toast.history === false) return false
  if (toast.variant === 'destructive' || toast.variant === 'warning') return true
  if (ROUTINE_TITLE.test(toast.title.trim())) return false
  return MEANINGFUL.test(`${toast.title} ${describeText(toast.description)}`)
}

export function recordEntry(entries: InboxEntry[], rawToast: InboxCandidate, now: number): InboxEntry[] {
  const toast = { ...rawToast, title: sanitizeInboxText(rawToast.title), href: sanitizeInboxHref(rawToast.href) }
  const variant = toast.variant ?? 'default'
  const accountId = typeof rawToast.accountId === 'string' && rawToast.accountId ? rawToast.accountId : undefined
  const description = sanitizeInboxText(describeText(rawToast.description))
  const actionTarget = sanitizeActionTarget(rawToast.actionTarget)
  // Two logins on one account fail independently: a sign-in notice's identity
  // includes the connection it points at, so each keeps its own entry and target.
  const signinTargetId = toast.actionHint === 'signin' ? actionTarget?.connectionId : undefined
  const match = entries.find(e => e.id === toast.id
    || (e.title === toast.title && e.variant === variant && e.accountId === accountId
      && (toast.actionHint !== 'signin' || e.actionTarget?.connectionId === signinTargetId)))
  const entry: InboxEntry = match
    ? { ...match, description, variant, href: toast.href ?? match.href, accountId, actionHint: toast.actionHint ?? match.actionHint, actionTarget: actionTarget ?? match.actionTarget, at: now, read: false, count: match.count + 1 }
    : { id: toast.id, title: toast.title, description, variant, href: toast.href, accountId, ...(toast.actionHint ? { actionHint: toast.actionHint } : {}), ...(actionTarget ? { actionTarget } : {}), at: now, read: false, count: 1 }
  return [entry, ...entries.filter(e => e !== match)].slice(0, INBOX_CAP)
}

export function unreadCount(entries: InboxEntry[]): number {
  return entries.reduce((n, e) => n + (e.read ? 0 : 1), 0)
}

export function markAllRead(entries: InboxEntry[]): InboxEntry[] {
  return entries.map(e => (e.read ? e : { ...e, read: true }))
}

export function markRead(entries: InboxEntry[], id: string): InboxEntry[] {
  return entries.map(e => (e.id === id && !e.read ? { ...e, read: true } : e))
}

// Seeing the list clears everything except errors, which stay unread until opened.
export function markSeen(entries: InboxEntry[]): InboxEntry[] {
  return entries.map(e => (e.read || e.variant === 'destructive' ? e : { ...e, read: true }))
}

export function groupByDay(entries: InboxEntry[], now: number): { today: InboxEntry[]; earlier: InboxEntry[] } {
  const today = new Date(now).toDateString()
  const todayEntries: InboxEntry[] = []
  const earlier: InboxEntry[] = []
  for (const e of entries) (new Date(e.at).toDateString() === today ? todayEntries : earlier).push(e)
  return { today: todayEntries, earlier }
}

export function parseStoredEntries(raw: unknown): InboxEntry[] {
  if (!Array.isArray(raw)) return []
  const out: InboxEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const e = item as Partial<InboxEntry>
    if (typeof e.id !== 'string' || typeof e.title !== 'string' || typeof e.at !== 'number') continue
    const actionTarget = sanitizeActionTarget(e.actionTarget)
    out.push({
      id: e.id,
      title: sanitizeInboxText(e.title),
      description: typeof e.description === 'string' ? sanitizeInboxText(e.description) : '',
      variant: e.variant === 'destructive' || e.variant === 'warning' ? e.variant : 'default',
      at: e.at,
      read: e.read === true,
      count: typeof e.count === 'number' && e.count > 0 ? e.count : 1,
      href: sanitizeInboxHref(e.href),
      ...(typeof e.accountId === 'string' && e.accountId ? { accountId: e.accountId } : {}),
      ...(e.actionHint === 'signin' ? { actionHint: 'signin' as const } : {}),
      ...(actionTarget ? { actionTarget } : {}),
    })
  }
  return out.sort((a, b) => b.at - a.at).slice(0, INBOX_CAP)
}

export interface SignInActionConnection {
  id: string
  enabled?: boolean
  status?: string
}

export type InboxSignInAction =
  | { kind: 'signin'; connectionId: string }
  | { kind: 'signin-generic' }
  | { kind: 'open-profile' }

/**
 * Resolves what a stored sign-in notice's button should do. An explicit action
 * target only ever opens its own connection: when that connection no longer
 * exists the button opens the profile instead of falling through to another
 * failing connection. Targetless notices keep the best-guess fallback.
 */
export function resolveInboxSignInAction(
  entry: Pick<InboxEntry, 'actionHint' | 'actionTarget'>,
  account: { connections?: SignInActionConnection[] } | null | undefined,
): InboxSignInAction | null {
  if (entry.actionHint !== 'signin' || !account) return null
  const connections = account.connections ?? []
  if (entry.actionTarget) {
    const target = connections.find(c => c.id === entry.actionTarget?.connectionId)
    return target ? { kind: 'signin', connectionId: target.id } : { kind: 'open-profile' }
  }
  const fallback = connections.find(c => c.enabled !== false && (c.status === 'error' || c.status === 'expired'))
  return fallback ? { kind: 'signin', connectionId: fallback.id } : { kind: 'signin-generic' }
}
