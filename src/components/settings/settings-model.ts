/**
 * Static model behind the settings home list and its detail pages.
 * Pure data only: no React, no store imports, so it stays testable under node:test.
 */

export type SettingsPageId =
    | 'account-sync'
    | 'appearance-privacy'
    | 'keys'
    | 'updates-activity'
    | 'devices-maintenance'
    | 'danger-zone'

export const SETTINGS_PAGE_IDS: readonly SettingsPageId[] = [
    'account-sync',
    'appearance-privacy',
    'keys',
    'updates-activity',
    'devices-maintenance',
    'danger-zone',
]

export type SettingsPageSelection = SettingsPageId | 'root'

/**
 * Old tab hashes (/settings#general and friends) plus the pre-regroup page
 * ids still land on the page that now holds that content.
 */
export const LEGACY_TAB_TO_PAGE: Readonly<Record<string, SettingsPageId>> = {
    general: 'account-sync',
    data: 'account-sync',
    identity: 'account-sync',
    appearance: 'appearance-privacy',
    privacy: 'appearance-privacy',
    'install-app': 'appearance-privacy',
    about: 'account-sync',
    advanced: 'updates-activity',
    notifications: 'updates-activity',
    'remembered-devices': 'devices-maintenance',
    diagnostics: 'devices-maintenance',
    repair: 'devices-maintenance',
}

export function resolveSettingsPage(rawHash: string): SettingsPageSelection {
    const id = rawHash.trim()
    if (!id) return 'root'
    if ((SETTINGS_PAGE_IDS as readonly string[]).includes(id)) return id as SettingsPageId
    return LEGACY_TAB_TO_PAGE[id] ?? 'root'
}

export type SettingsGroupId = 'pages' | 'danger'

export const SETTINGS_GROUP_ORDER: readonly SettingsGroupId[] = ['pages', 'danger']

export interface SettingsRowSpec {
    page: SettingsPageId
    title: string
    group: SettingsGroupId
    /** Primary data-settings-anchor rendered on the detail page. */
    anchor: string
}

// Account and sync has no row: the profile card at the top is that page's entry.
export const SETTINGS_ROWS: readonly SettingsRowSpec[] = [
    { page: 'appearance-privacy', title: 'Appearance and privacy', group: 'pages', anchor: 'themes' },
    { page: 'keys', title: 'Keys and integrations', group: 'pages', anchor: 'metadata-integrations' },
    { page: 'updates-activity', title: 'Updates and activity', group: 'pages', anchor: 'auto-update' },
    { page: 'devices-maintenance', title: 'Devices and maintenance', group: 'pages', anchor: 'remembered-devices' },
    { page: 'danger-zone', title: 'Danger zone', group: 'danger', anchor: 'danger-zone' },
]

export const SETTING_PAGE_LABELS: Record<SettingsPageId, string> = {
    'account-sync': 'Account and sync',
    'appearance-privacy': 'Appearance and privacy',
    keys: 'Keys and integrations',
    'updates-activity': 'Updates and activity',
    'devices-maintenance': 'Devices and maintenance',
    'danger-zone': 'Danger zone',
}

/** Compact labels for the desktop section bar; SETTING_PAGE_LABELS stay for the phone list and page headers. */
export const SETTINGS_TAB_SHORT_LABELS: Record<SettingsPageId, string> = {
    'account-sync': 'Account',
    'appearance-privacy': 'Appearance',
    keys: 'Keys',
    'updates-activity': 'Updates',
    'devices-maintenance': 'Devices',
    'danger-zone': 'Danger zone',
}

/**
 * The data-settings-anchor sections each page renders, in order. Must match
 * the section stacks in SettingsPage; install-app only renders when the
 * browser can install and sync-connections is empty-hidden when nothing mirrors.
 */
export const PAGE_SECTION_ANCHORS: Record<SettingsPageId, readonly string[]> = {
    'account-sync': ['sync-identity', 'sync-connections', 'backup-restore', 'about'],
    'appearance-privacy': ['themes', 'privacy-mode', 'install-app'],
    keys: ['metadata-integrations', 'api-keys'],
    'updates-activity': ['auto-update', 'live-activity', 'monitoring-alerts', 'history-cache'],
    'devices-maintenance': ['remembered-devices', 'sync-diagnostics', 'repair-recovery'],
    'danger-zone': ['danger-zone'],
}

/** Old tab and page hashes also name the section they used to open. */
export const LEGACY_HASH_TO_ANCHOR: Readonly<Record<string, string>> = {
    general: 'sync-identity',
    identity: 'sync-identity',
    data: 'backup-restore',
    appearance: 'themes',
    privacy: 'privacy-mode',
    'install-app': 'install-app',
    about: 'about',
    advanced: 'monitoring-alerts',
    notifications: 'monitoring-alerts',
    'remembered-devices': 'remembered-devices',
    diagnostics: 'sync-diagnostics',
    repair: 'repair-recovery',
}

/**
 * The one mounted page for the selected hash. Null is the phone home list;
 * desktop never shows the home list and opens on the first tab instead, so
 * the same content tree survives crossing the breakpoint.
 */
export function resolveSelectedPage(rawHash: string, desktop: boolean): SettingsPageId | null {
    const page = resolveSettingsPage(rawHash)
    if (page !== 'root') return page
    return desktop ? 'account-sync' : null
}

export interface SettingsDestination {
    page: SettingsPageId
    /** Section the hash used to open, for legacy deep links. */
    anchor?: string
}

/** Resolve a hash to its page and, for legacy hashes, its old section. */
export function resolveSettingsDestination(rawHash: string): SettingsDestination | null {
    const id = rawHash.trim()
    if (!id) return null
    const page = resolveSettingsPage(id)
    if (page === 'root') return null
    const anchor = LEGACY_HASH_TO_ANCHOR[id]
    return anchor ? { page, anchor } : { page }
}

/**
 * The legacy section jump for a hash, given the hash the guard last handled.
 * Consecutive identical hashes dedupe; any hash change re-arms the guard, so
 * #about, back home, #about jumps both times.
 */
export function nextLegacyJump(handledHash: string | null, rawHash: string): SettingsDestination | null {
    if (handledHash === rawHash) return null
    const destination = resolveSettingsDestination(rawHash)
    return destination?.anchor ? destination : null
}

/**
 * New scrollLeft for a vertical wheel event over the tab strip, or null when
 * the wheel must be released to the page (strip fits, or already at the end
 * in the wheel's direction).
 */
export function stripWheelTarget(scrollLeft: number, deltaY: number, maxScroll: number): number | null {
    if (deltaY === 0 || maxScroll <= 0) return null
    if (deltaY > 0 && scrollLeft >= maxScroll - 1) return null
    if (deltaY < 0 && scrollLeft <= 1) return null
    return Math.max(0, Math.min(maxScroll, scrollLeft + deltaY))
}

/** Which strip edges hide content and need a fade plus scroll chevron. */
export function stripFadeState(scrollLeft: number, clientWidth: number, scrollWidth: number): { left: boolean; right: boolean } {
    return {
        left: scrollLeft > 1,
        right: scrollLeft + clientWidth < scrollWidth - 1,
    }
}

/**
 * Mask a sync UUID for display: fixed dot run plus at most the last four
 * characters, so the identifier never renders in full.
 */
export function maskSyncId(id: string | null | undefined): string {
    if (!id) return ''
    const tail = id.length > 8 ? `\u2022${id.slice(-4)}` : ''
    const head = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'
    return tail ? `${head} ${tail}` : head
}
