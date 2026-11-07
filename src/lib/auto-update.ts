import { isNewerVersion } from './utils.ts'
import { normalizeAddonUrl } from './addon-url.ts'

export const AUTO_UPDATE_INTERVALS = [3, 6, 12, 24] as const
export type AutoUpdateInterval = typeof AUTO_UPDATE_INTERVALS[number]

/** Grey value shown on the "Check every" row, e.g. "Every 6 hours". */
export function autoUpdateIntervalLabel(hours: number): string {
    return `Every ${hours} hour${hours === 1 ? '' : 's'}`
}

export const AUTO_UPDATE_PLATFORMS = [
    { id: 'stremio', label: 'Stremio' },
    { id: 'nuvio', label: 'Nuvio' },
    { id: 'realstream', label: 'RealStream' },
] as const

export interface AutoUpdateSettings {
    enabled: boolean
    intervalHours: AutoUpdateInterval
    platforms: string[]
    excludedAccountIds: string[]
}

export const DEFAULT_AUTO_UPDATE_SETTINGS: AutoUpdateSettings = {
    enabled: true,
    intervalHours: 6,
    platforms: AUTO_UPDATE_PLATFORMS.map(p => p.id),
    excludedAccountIds: [],
}

const PLATFORM_IDS: string[] = AUTO_UPDATE_PLATFORMS.map(p => p.id)
const HOUR_MS = 60 * 60 * 1000

function stringList(value: unknown, allowed?: string[]): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    const out = [...new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200))]
    return allowed ? out.filter(v => allowed.includes(v)) : out
}

export function normalizeAutoUpdateSettings(value: unknown): AutoUpdateSettings {
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const interval = Number(raw.intervalHours)
    return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_AUTO_UPDATE_SETTINGS.enabled,
        intervalHours: (AUTO_UPDATE_INTERVALS as readonly number[]).includes(interval)
            ? interval as AutoUpdateInterval
            : DEFAULT_AUTO_UPDATE_SETTINGS.intervalHours,
        platforms: stringList(raw.platforms, PLATFORM_IDS) ?? [...DEFAULT_AUTO_UPDATE_SETTINGS.platforms],
        excludedAccountIds: stringList(raw.excludedAccountIds) ?? [],
    }
}

/** Local clock comparison only: the 30-minute tick may call this freely, the network check runs only when it returns true. */
export function isAutoUpdateDue(settings: AutoUpdateSettings, lastCheckAt: number, now: number): boolean {
    return now - lastCheckAt > settings.intervalHours * HOUR_MS
}

interface PlanConnection {
    platform: string
    connectionType?: string
    enabled: boolean
}

export interface AutoUpdatePlanAccount {
    id: string
    hasStremioAuth: boolean
    connections?: PlanConnection[]
    addons: Array<{ transportUrl: string; manifest?: { version?: string } }>
}

export interface AutoUpdateTarget {
    accountId: string
    urls: string[]
    includeStremio: boolean
    skipPlatforms: string[]
}

export function autoUpdatePlatformsOf(account: Pick<AutoUpdatePlanAccount, 'hasStremioAuth' | 'connections'>): string[] {
    const platforms = new Set<string>()
    if (account.hasStremioAuth) platforms.add('stremio')
    for (const c of account.connections ?? []) {
        if (!c.enabled || c.platform === 'stremio') continue
        if (c.connectionType != null && c.connectionType !== 'native') continue
        if (PLATFORM_IDS.includes(c.platform)) platforms.add(c.platform)
    }
    return [...platforms]
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/i

function isUpdatableVersion(installed: string | undefined, latest: string | undefined): boolean {
    if (!installed || !latest) return false
    const i = SEMVER.exec(installed.trim())
    if (!i || !SEMVER.test(latest.trim())) return false
    if (Number(i[1]) === 0 && Number(i[2]) === 0 && Number(i[3]) === 0) return false
    return isNewerVersion(installed.trim(), latest.trim())
}

/** Removal ids are `${accountId}::${transportUrl}::${index}`; any index for the same addon blocks it. */
export function isRemovalPending(pendingRemovalIds: Iterable<string>, accountId: string, transportUrl: string): boolean {
    const prefix = `${accountId}::${transportUrl}::`
    for (const id of pendingRemovalIds) if (id.startsWith(prefix)) return true
    return false
}

export interface AutoUpdatePlan {
    /** True when auto-update is off: the version check still runs for the indicator, but nothing is reinstalled. */
    checkOnly: boolean
    targets: AutoUpdateTarget[]
}

/** Decides which accounts get which outdated addons reinstalled; checkOnly means "indicate only". */
export function planAutoUpdateRun(
    settings: AutoUpdateSettings,
    accounts: AutoUpdatePlanAccount[],
    latestByUrl: Map<string, string>,
    pendingRemovalIds: Iterable<string> = [],
): AutoUpdatePlan {
    if (!settings.enabled) return { checkOnly: true, targets: [] }
    const pending = [...pendingRemovalIds]
    const excluded = new Set(settings.excludedAccountIds)
    const allowed = new Set(settings.platforms)
    const skipPlatforms = PLATFORM_IDS.filter(p => p !== 'stremio' && !allowed.has(p))
    const targets: AutoUpdateTarget[] = []
    for (const account of accounts) {
        if (excluded.has(account.id)) continue
        const platforms = autoUpdatePlatformsOf(account).filter(p => allowed.has(p))
        if (platforms.length === 0) continue
        const seen = new Set<string>()
        const urls: string[] = []
        for (const a of account.addons) {
            const key = normalizeAddonUrl(a.transportUrl)
            if (seen.has(key)) continue
            if (!isUpdatableVersion(a.manifest?.version, latestByUrl.get(key))) continue
            if (isRemovalPending(pending, account.id, a.transportUrl)) continue
            seen.add(key)
            urls.push(a.transportUrl)
        }
        if (urls.length === 0) continue
        targets.push({ accountId: account.id, urls, includeStremio: platforms.includes('stremio'), skipPlatforms })
    }
    return { checkOnly: false, targets }
}

export function planAutoUpdate(
    settings: AutoUpdateSettings,
    accounts: AutoUpdatePlanAccount[],
    latestByUrl: Map<string, string>,
    pendingRemovalIds: Iterable<string> = [],
): AutoUpdateTarget[] {
    return planAutoUpdateRun(settings, accounts, latestByUrl, pendingRemovalIds).targets
}
