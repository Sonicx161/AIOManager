import { useUIStore } from '@/store/uiStore'
import { mergeCustomThemes, persistCustomThemes } from '@/lib/theme-utils'
import { normalizeAutoUpdateSettings, type AutoUpdateSettings } from '@/lib/auto-update'
import { normalizeVaultHeaderSettings, type VaultHeaderSettings } from '@/lib/vault-header-keys'

export const SYNCED_SETTINGS_EVENT = 'aio-synced-settings-change'

export type SyncedViewMode = 'grid' | 'list'
export type ActivityTimeFilter = 'all' | '24h' | '7d' | '30d' | 'since'

export interface ActivitySettings {
    timeFilter?: ActivityTimeFilter
    sinceDate?: string
    viewMode?: SyncedViewMode
}

export interface NotesGraphSettings {
    linkDistance?: number
    repelStrength?: number
    centerGravity?: number
    rotation?: number
    showTags?: boolean
    showOrphans?: boolean
    nodeScale?: number
    transform?: { x: number; y: number; scale: number }
}

export interface SyncedSettings {
    theme?: string
    privacyMode?: boolean
    privacyLevelNames?: number
    privacyLevelUrls?: number
    privacyLevelProfiles?: number
    privacyLevelEmail?: number
    libraryViewMode?: SyncedViewMode
    accountsView?: SyncedViewMode
    addonListView?: SyncedViewMode
    hideDisabledAddons?: boolean
    addonPreviewCount?: number
    customThemes?: unknown[]
    changelog?: unknown[]
    activity?: ActivitySettings
    notesGraph?: NotesGraphSettings
    autoUpdate?: AutoUpdateSettings
    vaultHeader?: VaultHeaderSettings
}

const STORAGE_KEYS = {
    theme: 'aioman-theme',
    privacyMode: 'aioman:privacy-mode',
    privacyLevelNames: 'aioman:privacy-level-names',
    privacyLevelUrls: 'aioman:privacy-level-urls',
    privacyLevelProfiles: 'aioman:privacy-level-profiles',
    privacyLevelEmail: 'aioman:privacy-level-email',
    libraryViewMode: 'aioman:library-view-mode',
    accountsView: 'aioman:accounts-view',
    addonListView: 'aioman:addon-list-view',
    hideDisabledAddons: 'aioman:hide-disabled-addons',
    addonPreviewCount: 'aioman:addon-preview-count',
    customThemes: 'aio-custom-themes',
    autoUpdate: 'aioman:auto-update',
    vaultHeader: 'aioman:vault-header',
    activityTimeFilter: 'activity-time-filter',
    activitySinceDate: 'activity-since-date',
    activityViewMode: 'activity-view-mode',
    notesGraphLinkDistance: 'notes-graph-linkDist',
    notesGraphRepel: 'notes-graph-repel',
    notesGraphGravity: 'notes-graph-gravity',
    notesGraphRotation: 'notes-graph-rotation',
    notesGraphTags: 'notes-graph-tags',
    notesGraphOrphans: 'notes-graph-orphans',
    notesGraphNodeScale: 'notes-graph-nodeScale',
    notesGraphTransform: 'notes-graph-transform',
} as const

const isBrowser = () => typeof window !== 'undefined'

// Per-storage-key value the cloud last applied or a confirmed push published. A stored value
// that differs was edited locally after that point, so it is an unsynced edit: a later pull
// (even one judged "remote newer" from lastSyncedAt) never overwrites it, and the marker
// survives until a successful push republishes the local value.
const SYNCED_VALUES_KEY = 'aio:synced-settings-values'
const settingsStorageKeys = [...new Set(Object.values(STORAGE_KEYS))]

function readSyncedValueMap(): Record<string, string> {
    try {
        const parsed = JSON.parse(getStorageItem(SYNCED_VALUES_KEY) || '{}')
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
        return {}
    }
}

function writeSyncedValueMap(values: Record<string, string>): void {
    setStorageItem(SYNCED_VALUES_KEY, JSON.stringify(values))
}

function isUnsyncedLocalEdit(storageKey: string): boolean {
    const known = readSyncedValueMap()[storageKey]
    const stored = getStorageItem(storageKey)
    // A key this device never stored holds the default, which is not a local edit.
    return typeof known === 'string' && stored !== null && stored !== known
}

/** The storage form of the settings a push sends, defaults included, so keys edited mid-push stay unsynced. */
export function snapshotSyncedSettingsValues(sent: SyncedSettings): Record<string, string | null> {
    const values: Record<string, string | null> = Object.fromEntries(settingsStorageKeys.map(key => [key, null] as const))
    for (const [key, value] of incomingStoredValues(sent)) values[key] = value
    return values
}

/** A confirmed push made the sent values the cloud copy; keys edited since that snapshot stay unsynced. */
export function markSyncedSettingsPushed(sent?: Record<string, string | null>): void {
    const values = readSyncedValueMap()
    for (const key of settingsStorageKeys) {
        if (getStorageItem(key) === null) continue
        const value = sent ? sent[key] : getStorageItem(key)
        if (value !== null && value !== undefined) values[key] = value
    }
    writeSyncedValueMap(values)
}

function getStorageItem(key: string): string | null {
    if (!isBrowser()) return null
    try {
        return window.localStorage.getItem(key)
    } catch {
        return null
    }
}

function hasStorageItem(key: string): boolean {
    return getStorageItem(key) !== null
}

function setStorageItem(key: string, value: string): void {
    if (!isBrowser()) return
    try {
        window.localStorage.setItem(key, value)
    } catch {
        // Storage can be unavailable in private windows; keep in-memory state changes.
    }
}

function readBoolean(key: string, fallback: boolean): boolean {
    const stored = getStorageItem(key)
    if (stored === 'true') return true
    if (stored === 'false') return false
    if (stored !== null) {
        try {
            return Boolean(JSON.parse(stored))
        } catch {
            return fallback
        }
    }
    return fallback
}

function readNumber(key: string, fallback: number): number {
    const stored = getStorageItem(key)
    if (stored === null || stored === '') return fallback
    const value = Number(stored)
    return Number.isFinite(value) ? value : fallback
}

function readJsonArray(key: string): unknown[] {
    const stored = getStorageItem(key)
    if (!stored) return []
    try {
        const value = JSON.parse(stored)
        return Array.isArray(value) ? value : []
    } catch {
        return []
    }
}

function isViewMode(value: unknown): value is SyncedViewMode {
    return value === 'grid' || value === 'list'
}

function isActivityTimeFilter(value: unknown): value is ActivityTimeFilter {
    return value === 'all' || value === '24h' || value === '7d' || value === '30d' || value === 'since'
}

function asFiniteNumber(value: unknown): number | undefined {
    const numberValue = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(numberValue) ? numberValue : undefined
}

function readTransform(): { x: number; y: number; scale: number } {
    const stored = getStorageItem(STORAGE_KEYS.notesGraphTransform)
    if (!stored) return { x: 0, y: 0, scale: 1 }
    try {
        return normalizeTransform(JSON.parse(stored)) || { x: 0, y: 0, scale: 1 }
    } catch {
        return { x: 0, y: 0, scale: 1 }
    }
}

function normalizeTransform(value: unknown): { x: number; y: number; scale: number } | undefined {
    if (!value || typeof value !== 'object') return undefined
    const raw = value as Record<string, unknown>
    const x = asFiniteNumber(raw.x)
    const y = asFiniteNumber(raw.y)
    const scale = asFiniteNumber(raw.scale)
    if (x === undefined || y === undefined || scale === undefined) return undefined
    return { x, y, scale }
}

function normalizeActivitySettings(value: unknown): ActivitySettings | undefined {
    if (!value || typeof value !== 'object') return undefined
    const raw = value as Record<string, unknown>
    const next: ActivitySettings = {}

    if (isActivityTimeFilter(raw.timeFilter)) next.timeFilter = raw.timeFilter
    if (typeof raw.sinceDate === 'string' && raw.sinceDate.length <= 32) next.sinceDate = raw.sinceDate
    if (isViewMode(raw.viewMode)) next.viewMode = raw.viewMode

    return Object.keys(next).length > 0 ? next : undefined
}

function normalizeNotesGraphSettings(value: unknown): NotesGraphSettings | undefined {
    if (!value || typeof value !== 'object') return undefined
    const raw = value as Record<string, unknown>
    const next: NotesGraphSettings = {}

    const linkDistance = asFiniteNumber(raw.linkDistance)
    const repelStrength = asFiniteNumber(raw.repelStrength)
    const centerGravity = asFiniteNumber(raw.centerGravity)
    const rotation = asFiniteNumber(raw.rotation)
    const nodeScale = asFiniteNumber(raw.nodeScale)
    const transform = normalizeTransform(raw.transform)

    if (linkDistance !== undefined) next.linkDistance = linkDistance
    if (repelStrength !== undefined) next.repelStrength = repelStrength
    if (centerGravity !== undefined) next.centerGravity = centerGravity
    if (rotation !== undefined) next.rotation = rotation
    if (typeof raw.showTags === 'boolean') next.showTags = raw.showTags
    if (typeof raw.showOrphans === 'boolean') next.showOrphans = raw.showOrphans
    if (nodeScale !== undefined) next.nodeScale = nodeScale
    if (transform) next.transform = transform

    return Object.keys(next).length > 0 ? next : undefined
}

function getIncomingActivitySettings(settings: SyncedSettings): ActivitySettings | undefined {
    const raw = settings as Record<string, unknown>
    return normalizeActivitySettings({
        ...(settings.activity || {}),
        timeFilter: settings.activity?.timeFilter ?? raw.activityTimeFilter,
        sinceDate: settings.activity?.sinceDate ?? raw.activitySinceDate,
        viewMode: settings.activity?.viewMode ?? raw.activityViewMode,
    })
}

function getIncomingNotesGraphSettings(settings: SyncedSettings): NotesGraphSettings | undefined {
    const raw = settings as Record<string, unknown>
    return normalizeNotesGraphSettings(settings.notesGraph || raw.notesGraphSettings)
}

function dispatchSettingsChanged(detail: SyncedSettings): void {
    if (!isBrowser()) return
    window.dispatchEvent(new CustomEvent(SYNCED_SETTINGS_EVENT, { detail }))
}

export function readAutoUpdateSettings(): AutoUpdateSettings {
    const stored = getStorageItem(STORAGE_KEYS.autoUpdate)
    if (!stored) return normalizeAutoUpdateSettings(undefined)
    try {
        return normalizeAutoUpdateSettings(JSON.parse(stored))
    } catch {
        return normalizeAutoUpdateSettings(undefined)
    }
}

export function writeAutoUpdateSettings(next: AutoUpdateSettings): AutoUpdateSettings {
    const normalized = normalizeAutoUpdateSettings(next)
    setStorageItem(STORAGE_KEYS.autoUpdate, JSON.stringify(normalized))
    dispatchSettingsChanged({ autoUpdate: normalized })
    return normalized
}

export function readVaultHeaderSettings(): VaultHeaderSettings {
    const stored = getStorageItem(STORAGE_KEYS.vaultHeader)
    if (!stored) return normalizeVaultHeaderSettings(undefined)
    try {
        return normalizeVaultHeaderSettings(JSON.parse(stored))
    } catch {
        return normalizeVaultHeaderSettings(undefined)
    }
}

export function writeVaultHeaderSettings(next: VaultHeaderSettings): VaultHeaderSettings {
    const normalized = normalizeVaultHeaderSettings(next)
    setStorageItem(STORAGE_KEYS.vaultHeader, JSON.stringify(normalized))
    dispatchSettingsChanged({ vaultHeader: normalized })
    return normalized
}

export function readSyncedSettings(): SyncedSettings {
    const uiState = useUIStore.getState()
    return {
        theme: getStorageItem(STORAGE_KEYS.theme) || 'dark',
        privacyMode: uiState.isPrivacyModeEnabled,
        privacyLevelNames: readNumber(STORAGE_KEYS.privacyLevelNames, uiState.privacyLevelNames ?? 0),
        privacyLevelUrls: readNumber(STORAGE_KEYS.privacyLevelUrls, uiState.privacyLevelUrls ?? 0),
        privacyLevelProfiles: readNumber(STORAGE_KEYS.privacyLevelProfiles, uiState.privacyLevelProfiles ?? 0),
        privacyLevelEmail: readNumber(STORAGE_KEYS.privacyLevelEmail, uiState.privacyLevelEmail ?? 0),
        libraryViewMode: uiState.libraryViewMode,
        accountsView: uiState.accountsView,
        addonListView: uiState.addonListView,
        hideDisabledAddons: readBoolean(STORAGE_KEYS.hideDisabledAddons, false),
        addonPreviewCount: readNumber(STORAGE_KEYS.addonPreviewCount, 4),
        customThemes: readJsonArray(STORAGE_KEYS.customThemes),
        autoUpdate: readAutoUpdateSettings(),
        ...(hasStorageItem(STORAGE_KEYS.vaultHeader) ? { vaultHeader: readVaultHeaderSettings() } : {}),
        activity: {
            timeFilter: isActivityTimeFilter(getStorageItem(STORAGE_KEYS.activityTimeFilter))
                ? getStorageItem(STORAGE_KEYS.activityTimeFilter) as ActivityTimeFilter
                : 'all',
            sinceDate: getStorageItem(STORAGE_KEYS.activitySinceDate) || '',
            viewMode: getStorageItem(STORAGE_KEYS.activityViewMode) === 'list' ? 'list' : 'grid',
        },
        notesGraph: {
            linkDistance: readNumber(STORAGE_KEYS.notesGraphLinkDistance, 150),
            repelStrength: readNumber(STORAGE_KEYS.notesGraphRepel, 5000),
            centerGravity: readNumber(STORAGE_KEYS.notesGraphGravity, 0.01),
            rotation: readNumber(STORAGE_KEYS.notesGraphRotation, 0),
            showTags: readBoolean(STORAGE_KEYS.notesGraphTags, false),
            showOrphans: readBoolean(STORAGE_KEYS.notesGraphOrphans, true),
            nodeScale: readNumber(STORAGE_KEYS.notesGraphNodeScale, 1),
            transform: readTransform(),
        },
    }
}

/** Incoming settings as their storage strings; only keys the payload actually carries. */
function incomingStoredValues(settings: SyncedSettings): Array<[string, string]> {
    const pairs: Array<[string, string]> = []
    const add = (key: string, value: string) => { pairs.push([key, value]) }
    if (typeof settings.theme === 'string' && settings.theme) add(STORAGE_KEYS.theme, settings.theme)
    if (typeof settings.privacyMode === 'boolean') add(STORAGE_KEYS.privacyMode, JSON.stringify(settings.privacyMode))
    if (typeof settings.privacyLevelNames === 'number') add(STORAGE_KEYS.privacyLevelNames, String(settings.privacyLevelNames))
    if (typeof settings.privacyLevelUrls === 'number') add(STORAGE_KEYS.privacyLevelUrls, String(settings.privacyLevelUrls))
    if (typeof settings.privacyLevelProfiles === 'number') add(STORAGE_KEYS.privacyLevelProfiles, String(settings.privacyLevelProfiles))
    if (typeof settings.privacyLevelEmail === 'number') add(STORAGE_KEYS.privacyLevelEmail, String(settings.privacyLevelEmail))
    if (isViewMode(settings.libraryViewMode)) add(STORAGE_KEYS.libraryViewMode, settings.libraryViewMode)
    if (isViewMode(settings.accountsView)) add(STORAGE_KEYS.accountsView, settings.accountsView)
    if (isViewMode(settings.addonListView)) add(STORAGE_KEYS.addonListView, settings.addonListView)
    if (typeof settings.hideDisabledAddons === 'boolean') add(STORAGE_KEYS.hideDisabledAddons, String(settings.hideDisabledAddons))
    if (typeof settings.addonPreviewCount === 'number') add(STORAGE_KEYS.addonPreviewCount, String(settings.addonPreviewCount))
    if (Array.isArray(settings.customThemes)) add(STORAGE_KEYS.customThemes, JSON.stringify(settings.customThemes))
    if (settings.autoUpdate && typeof settings.autoUpdate === 'object') add(STORAGE_KEYS.autoUpdate, JSON.stringify(normalizeAutoUpdateSettings(settings.autoUpdate)))
    if (settings.vaultHeader && typeof settings.vaultHeader === 'object') add(STORAGE_KEYS.vaultHeader, JSON.stringify(normalizeVaultHeaderSettings(settings.vaultHeader)))
    const activity = getIncomingActivitySettings(settings)
    if (activity) {
        if (activity.timeFilter) add(STORAGE_KEYS.activityTimeFilter, activity.timeFilter)
        if (typeof activity.sinceDate === 'string') add(STORAGE_KEYS.activitySinceDate, activity.sinceDate)
        if (activity.viewMode) add(STORAGE_KEYS.activityViewMode, activity.viewMode)
    }
    const notesGraph = getIncomingNotesGraphSettings(settings)
    if (notesGraph) {
        if (notesGraph.linkDistance !== undefined) add(STORAGE_KEYS.notesGraphLinkDistance, String(notesGraph.linkDistance))
        if (notesGraph.repelStrength !== undefined) add(STORAGE_KEYS.notesGraphRepel, String(notesGraph.repelStrength))
        if (notesGraph.centerGravity !== undefined) add(STORAGE_KEYS.notesGraphGravity, String(notesGraph.centerGravity))
        if (notesGraph.rotation !== undefined) add(STORAGE_KEYS.notesGraphRotation, String(notesGraph.rotation))
        if (notesGraph.showTags !== undefined) add(STORAGE_KEYS.notesGraphTags, String(notesGraph.showTags))
        if (notesGraph.showOrphans !== undefined) add(STORAGE_KEYS.notesGraphOrphans, String(notesGraph.showOrphans))
        if (notesGraph.nodeScale !== undefined) add(STORAGE_KEYS.notesGraphNodeScale, String(notesGraph.nodeScale))
        if (notesGraph.transform) add(STORAGE_KEYS.notesGraphTransform, JSON.stringify(notesGraph.transform))
    }
    return pairs
}

export function applySyncedSettings(settings: SyncedSettings | undefined, overwrite = true, options: { protectLocalEdits?: boolean } = {}): void {
    if (!settings) return
    const applied: SyncedSettings = {}
    const shouldWrite = (key: string) => (overwrite || !hasStorageItem(key)) && !(options.protectLocalEdits && isUnsyncedLocalEdit(key))

    const themesEditedLocally = !!options.protectLocalEdits && isUnsyncedLocalEdit(STORAGE_KEYS.customThemes)
    if (Array.isArray(settings.customThemes) && settings.customThemes.length > 0) {
        const existing = readJsonArray(STORAGE_KEYS.customThemes)
        // A locally edited theme list keeps its same-ID winners: local becomes the merge priority.
        const merged = themesEditedLocally
            ? mergeCustomThemes(existing, settings.customThemes as unknown[])
            : mergeCustomThemes(settings.customThemes as unknown[], existing as unknown[])
        persistCustomThemes(merged)
        applied.customThemes = merged
    }

    if (typeof settings.theme === 'string' && settings.theme && shouldWrite(STORAGE_KEYS.theme)) {
        setStorageItem(STORAGE_KEYS.theme, settings.theme)
        if (isBrowser()) {
            setTimeout(() => {
                window.dispatchEvent(new CustomEvent('aio-theme-change', { detail: { value: settings.theme } }))
            }, 50)
        }
        applied.theme = settings.theme
    }

    if (typeof settings.privacyMode === 'boolean' && shouldWrite(STORAGE_KEYS.privacyMode)) {
        setStorageItem(STORAGE_KEYS.privacyMode, JSON.stringify(settings.privacyMode))
        useUIStore.setState({ isPrivacyModeEnabled: settings.privacyMode })
        applied.privacyMode = settings.privacyMode
    }

    if (typeof settings.privacyLevelNames === 'number' && shouldWrite(STORAGE_KEYS.privacyLevelNames)) {
        setStorageItem(STORAGE_KEYS.privacyLevelNames, String(settings.privacyLevelNames))
        useUIStore.setState({ privacyLevelNames: settings.privacyLevelNames })
        applied.privacyLevelNames = settings.privacyLevelNames
    }
    if (typeof settings.privacyLevelUrls === 'number' && shouldWrite(STORAGE_KEYS.privacyLevelUrls)) {
        setStorageItem(STORAGE_KEYS.privacyLevelUrls, String(settings.privacyLevelUrls))
        useUIStore.setState({ privacyLevelUrls: settings.privacyLevelUrls })
        applied.privacyLevelUrls = settings.privacyLevelUrls
    }
    if (typeof settings.privacyLevelProfiles === 'number' && shouldWrite(STORAGE_KEYS.privacyLevelProfiles)) {
        setStorageItem(STORAGE_KEYS.privacyLevelProfiles, String(settings.privacyLevelProfiles))
        useUIStore.setState({ privacyLevelProfiles: settings.privacyLevelProfiles })
        applied.privacyLevelProfiles = settings.privacyLevelProfiles
    }
    if (typeof settings.privacyLevelEmail === 'number' && shouldWrite(STORAGE_KEYS.privacyLevelEmail)) {
        setStorageItem(STORAGE_KEYS.privacyLevelEmail, String(settings.privacyLevelEmail))
        useUIStore.setState({ privacyLevelEmail: settings.privacyLevelEmail })
        applied.privacyLevelEmail = settings.privacyLevelEmail
    }

    if (isViewMode(settings.libraryViewMode) && shouldWrite(STORAGE_KEYS.libraryViewMode)) {
        setStorageItem(STORAGE_KEYS.libraryViewMode, settings.libraryViewMode)
        useUIStore.setState({ libraryViewMode: settings.libraryViewMode })
        applied.libraryViewMode = settings.libraryViewMode
    }

    if (isViewMode(settings.accountsView) && shouldWrite(STORAGE_KEYS.accountsView)) {
        setStorageItem(STORAGE_KEYS.accountsView, settings.accountsView)
        useUIStore.setState({ accountsView: settings.accountsView })
        applied.accountsView = settings.accountsView
    }

    if (isViewMode(settings.addonListView) && shouldWrite(STORAGE_KEYS.addonListView)) {
        setStorageItem(STORAGE_KEYS.addonListView, settings.addonListView)
        useUIStore.setState({ addonListView: settings.addonListView })
        applied.addonListView = settings.addonListView
    }

    if (typeof settings.hideDisabledAddons === 'boolean' && shouldWrite(STORAGE_KEYS.hideDisabledAddons)) {
        setStorageItem(STORAGE_KEYS.hideDisabledAddons, String(settings.hideDisabledAddons))
        applied.hideDisabledAddons = settings.hideDisabledAddons
    }

    if (typeof settings.addonPreviewCount === 'number' && shouldWrite(STORAGE_KEYS.addonPreviewCount)) {
        setStorageItem(STORAGE_KEYS.addonPreviewCount, String(settings.addonPreviewCount))
        applied.addonPreviewCount = settings.addonPreviewCount
    }

    if (settings.autoUpdate && typeof settings.autoUpdate === 'object' && shouldWrite(STORAGE_KEYS.autoUpdate)) {
        const autoUpdate = normalizeAutoUpdateSettings(settings.autoUpdate)
        setStorageItem(STORAGE_KEYS.autoUpdate, JSON.stringify(autoUpdate))
        applied.autoUpdate = autoUpdate
    }

    if (settings.vaultHeader && typeof settings.vaultHeader === 'object' && shouldWrite(STORAGE_KEYS.vaultHeader)) {
        const vaultHeader = normalizeVaultHeaderSettings(settings.vaultHeader)
        setStorageItem(STORAGE_KEYS.vaultHeader, JSON.stringify(vaultHeader))
        applied.vaultHeader = vaultHeader
    }

    const activity = getIncomingActivitySettings(settings)
    if (activity) {
        const appliedActivity: ActivitySettings = {}
        if (activity.timeFilter && shouldWrite(STORAGE_KEYS.activityTimeFilter)) {
            setStorageItem(STORAGE_KEYS.activityTimeFilter, activity.timeFilter)
            appliedActivity.timeFilter = activity.timeFilter
        }
        if (typeof activity.sinceDate === 'string' && shouldWrite(STORAGE_KEYS.activitySinceDate)) {
            setStorageItem(STORAGE_KEYS.activitySinceDate, activity.sinceDate)
            appliedActivity.sinceDate = activity.sinceDate
        }
        if (activity.viewMode && shouldWrite(STORAGE_KEYS.activityViewMode)) {
            setStorageItem(STORAGE_KEYS.activityViewMode, activity.viewMode)
            appliedActivity.viewMode = activity.viewMode
        }
        if (Object.keys(appliedActivity).length > 0) applied.activity = appliedActivity
    }

    const notesGraph = getIncomingNotesGraphSettings(settings)
    if (notesGraph) {
        const appliedNotesGraph: NotesGraphSettings = {}
        const writeNumber = (key: string, field: keyof NotesGraphSettings, value: number | undefined) => {
            if (value === undefined || !shouldWrite(key)) return
            setStorageItem(key, String(value))
            ;(appliedNotesGraph as Record<string, unknown>)[field] = value
        }
        const writeBoolean = (key: string, field: keyof NotesGraphSettings, value: boolean | undefined) => {
            if (value === undefined || !shouldWrite(key)) return
            setStorageItem(key, String(value))
            ;(appliedNotesGraph as Record<string, unknown>)[field] = value
        }

        writeNumber(STORAGE_KEYS.notesGraphLinkDistance, 'linkDistance', notesGraph.linkDistance)
        writeNumber(STORAGE_KEYS.notesGraphRepel, 'repelStrength', notesGraph.repelStrength)
        writeNumber(STORAGE_KEYS.notesGraphGravity, 'centerGravity', notesGraph.centerGravity)
        writeNumber(STORAGE_KEYS.notesGraphRotation, 'rotation', notesGraph.rotation)
        writeBoolean(STORAGE_KEYS.notesGraphTags, 'showTags', notesGraph.showTags)
        writeBoolean(STORAGE_KEYS.notesGraphOrphans, 'showOrphans', notesGraph.showOrphans)
        writeNumber(STORAGE_KEYS.notesGraphNodeScale, 'nodeScale', notesGraph.nodeScale)
        if (notesGraph.transform && shouldWrite(STORAGE_KEYS.notesGraphTransform)) {
            setStorageItem(STORAGE_KEYS.notesGraphTransform, JSON.stringify(notesGraph.transform))
            appliedNotesGraph.transform = notesGraph.transform
        }
        if (Object.keys(appliedNotesGraph).length > 0) applied.notesGraph = appliedNotesGraph
    }

    if (options.protectLocalEdits) {
        // Incoming keys whose stored value now equals the incoming value are the cloud copy,
        // unchanged-equal included; keys a local edit moved away keep their unsynced marker.
        const values = readSyncedValueMap()
        for (const [key, value] of incomingStoredValues(settings)) {
            if (key === STORAGE_KEYS.customThemes) {
                const stored = getStorageItem(key)
                if (!themesEditedLocally && stored !== null) values[key] = stored
                continue
            }
            if (getStorageItem(key) === value) values[key] = value
        }
        writeSyncedValueMap(values)
    }

    if (Object.keys(applied).length > 0) {
        dispatchSettingsChanged(applied)
    }
}
