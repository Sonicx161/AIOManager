export type HeaderKeyStatus = 'expired' | 'expiring' | 'healthy' | 'error' | 'unknown'

export interface HeaderKeyInput {
  id: string
  provider: string
  group: string
  customExpiry?: string
  serverUrl?: string
  addonUuid?: string
}

export interface HeaderKeyHealth {
  status: 'none' | 'active' | 'expired' | 'error'
  daysRemaining: number | null
  expiresAt: string | null
  loading?: boolean
}

export interface HeaderKeyRow<K extends HeaderKeyInput> {
  key: K
  status: HeaderKeyStatus
  days: number | null
  expiresAt: string | null
  pinned: boolean
  attention: boolean
  checking: boolean
  forced: boolean
}

export interface VaultHeaderSettings {
  mode: 'auto' | 'custom'
  include: string[]
  exclude: string[]
  alwaysShowExpiring: boolean
  pins?: string[]
}

export const DEFAULT_VAULT_HEADER_SETTINGS: VaultHeaderSettings = {
  mode: 'auto',
  include: [],
  exclude: [],
  alwaysShowExpiring: true,
}

const MAX_HEADER_IDS = 500

const DEBRID_PROVIDERS = new Set(['real-debrid', 'torbox', 'premiumize', 'alldebrid', 'debrid-link'])
const INSTANCE_PROVIDERS = new Set(['aiostreams', 'aiometadata'])
const TRACKED_GROUPS = new Set(['Debrid Services', 'Usenet Providers', 'Usenet Indexers', 'Torrent Indexers'])
const EXPIRING_DAYS = 30
const DAY_MS = 86_400_000

// Default header scope is decided by provider category, never by whether health is known yet.
// AIOStreams and AIOMetadata credentials, and any other non-expiring instance credential,
// stay in the Vault page unless the user includes them.
export function isHeaderVaultKey(key: HeaderKeyInput, health?: HeaderKeyHealth): boolean {
  if (INSTANCE_PROVIDERS.has(key.provider)) return false
  if (DEBRID_PROVIDERS.has(key.provider)) return true
  if (key.customExpiry) return true
  if (key.addonUuid && !health?.expiresAt) return false
  if (TRACKED_GROUPS.has(key.group)) return true
  if (key.serverUrl && !health?.expiresAt) return false
  return !!health && (health.status === 'active' || health.status === 'expired') && health.expiresAt !== null
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && item.length <= 128) ids.add(item)
    if (ids.size >= MAX_HEADER_IDS) break
  }
  return [...ids]
}

// Only ids and flags survive normalization, so labels or values can never be persisted.
export function normalizeVaultHeaderSettings(value: unknown): VaultHeaderSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_VAULT_HEADER_SETTINGS, include: [], exclude: [] }
  const raw = value as Record<string, unknown>
  const exclude = normalizeIds(raw.exclude)
  const excluded = new Set(exclude)
  return {
    mode: raw.mode === 'custom' ? 'custom' : 'auto',
    include: normalizeIds(raw.include).filter(id => !excluded.has(id)),
    exclude,
    alwaysShowExpiring: typeof raw.alwaysShowExpiring === 'boolean' ? raw.alwaysShowExpiring : true,
    ...(Array.isArray(raw.pins) ? { pins: normalizeIds(raw.pins) } : {}),
  }
}

export function parseLegacyPins(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    return normalizeIds(JSON.parse(raw))
  } catch {
    return []
  }
}

// Synced pins win once present; until then the old per-workspace local list is the fallback.
export function resolveHeaderPins(settings: VaultHeaderSettings, legacy: readonly string[]): string[] {
  return settings.pins ?? normalizeIds([...legacy])
}

export function needsPinMigration(settings: VaultHeaderSettings, legacy: readonly string[]): boolean {
  return settings.pins === undefined && legacy.length > 0
}

export function toggleHeaderPin(settings: VaultHeaderSettings, legacy: readonly string[], id: string): VaultHeaderSettings {
  const current = resolveHeaderPins(settings, legacy)
  const pins = current.includes(id) ? current.filter(p => p !== id) : [...current, id]
  return normalizeVaultHeaderSettings({ ...settings, pins })
}

export function resetVaultHeaderSettings(settings: VaultHeaderSettings): VaultHeaderSettings {
  return normalizeVaultHeaderSettings({ ...DEFAULT_VAULT_HEADER_SETTINGS, ...(settings.pins ? { pins: settings.pins } : {}) })
}

export function isDefaultVaultHeaderSettings(settings: VaultHeaderSettings): boolean {
  return settings.mode === 'auto' && settings.include.length === 0 && settings.exclude.length === 0 && settings.alwaysShowExpiring
}

export function setVaultHeaderShown(settings: VaultHeaderSettings, id: string, shown: boolean): VaultHeaderSettings {
  const include = settings.include.filter(x => x !== id)
  const exclude = settings.exclude.filter(x => x !== id)
  if (shown) include.push(id)
  else exclude.push(id)
  return normalizeVaultHeaderSettings({ ...settings, include, exclude })
}

export function setVaultHeaderMode(settings: VaultHeaderSettings, mode: 'auto' | 'custom', shownIds: readonly string[]): VaultHeaderSettings {
  if (mode === settings.mode) return settings
  if (mode === 'auto') return { ...settings, mode }
  const excluded = new Set(settings.exclude)
  return normalizeVaultHeaderSettings({ ...settings, mode, include: shownIds.filter(id => !excluded.has(id)) })
}

export interface HeaderVisibility {
  // User selection plus category scope, before the expiring override.
  selected: boolean
  // Shown only because it expired or is expiring while its exclusion would otherwise hide it.
  forced: boolean
}

export function resolveHeaderVisibility(
  key: HeaderKeyInput,
  health: HeaderKeyHealth | undefined,
  pinned: boolean,
  settings: VaultHeaderSettings,
  attention: boolean,
): HeaderVisibility {
  const included = settings.include.includes(key.id) || pinned
  const excluded = settings.exclude.includes(key.id)
  const inScope = isHeaderVaultKey(key, health)
  const selected = !excluded && (settings.mode === 'custom' ? included : inScope || included)
  const rescuable = inScope || included
  const forced = !selected && settings.alwaysShowExpiring && attention && rescuable
  return { selected, forced }
}

export function classifyKey(key: HeaderKeyInput, health: HeaderKeyHealth | undefined, now: number) {
  let days: number | null = health?.daysRemaining ?? null
  let expiresAt: string | null = health?.expiresAt ?? null
  if (days === null && key.customExpiry) {
    const t = new Date(key.customExpiry).getTime()
    if (!Number.isNaN(t)) {
      days = Math.ceil((t - now) / DAY_MS)
      expiresAt = key.customExpiry
    }
  }
  let status: HeaderKeyStatus = 'unknown'
  if (health?.status === 'error' && days === null) status = 'error'
  else if (health?.status === 'expired' || (days !== null && days <= 0)) status = 'expired'
  else if (days !== null && days <= EXPIRING_DAYS) status = 'expiring'
  else if (days !== null || health?.status === 'active') status = 'healthy'
  return { status, days, expiresAt }
}

export function buildHeaderRows<K extends HeaderKeyInput>(
  keys: K[],
  health: Record<string, HeaderKeyHealth | undefined>,
  pins: ReadonlySet<string>,
  now: number,
  settings: VaultHeaderSettings = DEFAULT_VAULT_HEADER_SETTINGS,
): HeaderKeyRow<K>[] {
  const rows: HeaderKeyRow<K>[] = []
  for (const key of keys) {
    const h = health[key.id]
    const { status, days, expiresAt } = classifyKey(key, h, now)
    const attention = status === 'expired' || status === 'expiring'
    const pinned = pins.has(key.id)
    const { selected, forced } = resolveHeaderVisibility(key, h, pinned, settings, attention)
    if (!selected && !forced) continue
    const checking = status === 'unknown' && days === null && (!h || h.loading === true)
    rows.push({ key, status, days, expiresAt, pinned, attention, checking, forced })
  }
  const byDays = (a: HeaderKeyRow<K>, b: HeaderKeyRow<K>) =>
    Number(b.pinned) - Number(a.pinned) || (a.days ?? Infinity) - (b.days ?? Infinity) || a.key.id.localeCompare(b.key.id)
  return [...rows.filter(r => r.attention).sort(byDays), ...rows.filter(r => !r.attention).sort(byDays)]
}

export function formatDaysLeft(days: number): string {
  if (days <= 0) return 'Expired'
  if (days <= 45) return `${days}d left`
  if (days < 365) return `${Math.round(days / 30)}mo left`
  const years = Math.floor(days / 365)
  const months = Math.floor((days % 365) / 30)
  return `${years}y${months > 0 ? ` ${months}mo` : ''} left`
}

// Triggers the vault health check at most once per session when none has ever run.
export function createHealthRequester(deps: {
  hydrate: () => Promise<void>
  needsCheck: () => boolean
  refresh: () => Promise<void>
}): () => Promise<void> {
  let requested = false
  return async () => {
    if (requested) return
    requested = true
    await deps.hydrate()
    if (deps.needsCheck()) await deps.refresh()
  }
}
