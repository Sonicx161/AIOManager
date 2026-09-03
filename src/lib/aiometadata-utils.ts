import { AddonDescriptor } from '@/types/addon'
import { useVaultStore } from '@/store/vaultStore'
import { useSyncStore } from '@/store/syncStore'
import { deriveSyncToken } from '@/lib/crypto'

const AIOMETADATA_MANIFEST_IDS = [
    'aio-metadata',
    'aiometadata',
]

export function isAIOMetadataAddon(addon: AddonDescriptor): boolean {
    if (!addon) return false
    const id = addon.manifest?.id?.toLowerCase() || ''
    const name = addon.manifest?.name?.toLowerCase() || ''
    if (AIOMETADATA_MANIFEST_IDS.some(k => id.includes(k))) return true
    if (name === 'aiometadata') return true
    return false
}

export function parseAIOMetadataUrl(transportUrl: string): { baseUrl: string; uuid: string } | null {
    try {
        const match = transportUrl.match(/^(https?:\/\/.+?)\/stremio\/([^/]+)\//i)
        if (!match) return null
        return { baseUrl: match[1], uuid: decodeURIComponent(match[2]) }
    } catch {
        return null
    }
}

export function getAIOMetadataConfigureUrl(transportUrl: string): string | null {
    try {
        const [base, query] = transportUrl.split('?')
        const configure = base.replace(/\/manifest(\.json)?$/i, '/configure').replace(/([^:]\/)\/+/g, '$1')
        return query ? `${configure}?${query}` : configure
    } catch {
        return null
    }
}

function normalizeAuthError(message: string): string {
    return message.replace(/uuid\s+or\s+/gi, '').replace(/\binvalid uuid\b/gi, 'Invalid password')
}

async function authHeaders(): Promise<Record<string, string>> {
    const auth = useSyncStore.getState().auth
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (auth.isAuthenticated) {
        headers['x-sync-user'] = auth.id
        headers['x-sync-password'] = await deriveSyncToken(auth.password)
    }
    return headers
}

export interface AIOMetadataAddonInfo {
    version?: string
    requiresAddonPassword?: boolean
    [key: string]: unknown
}

export async function fetchAIOMetadataStatus(baseUrl: string): Promise<AIOMetadataAddonInfo | null> {
    try {
        const auth = useSyncStore.getState().auth
        const headers: Record<string, string> = {}
        if (auth.isAuthenticated) {
            headers['x-sync-user'] = auth.id
            headers['x-sync-password'] = await deriveSyncToken(auth.password)
        }
        const params = new URLSearchParams({ baseUrl })
        const res = await fetch(`/api/aiometadata-status?${params}`, { headers })
        const json = await res.json()
        if (!json.success) return null
        return json.data as AIOMetadataAddonInfo
    } catch {
        return null
    }
}

export async function checkAIOMetadataTrusted(baseUrl: string, uuid: string): Promise<boolean | null> {
    try {
        const auth = useSyncStore.getState().auth
        const headers: Record<string, string> = {}
        if (auth.isAuthenticated) {
            headers['x-sync-user'] = auth.id
            headers['x-sync-password'] = await deriveSyncToken(auth.password)
        }
        const params = new URLSearchParams({ baseUrl, uuid })
        const res = await fetch(`/api/aiometadata-check?${params}`, { headers })
        const json = await res.json()
        if (!json.success) return null
        const data = json.data as { trusted?: boolean } | undefined
        return data?.trusted ?? null
    } catch {
        return null
    }
}

export async function fetchAIOMetadataConfig(
    baseUrl: string,
    uuid: string,
    password: string,
    addonPassword?: string
): Promise<Record<string, unknown>> {
    const res = await fetch('/api/aiometadata-proxy/load', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ baseUrl, uuid, password, addonPassword }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(normalizeAuthError(json.error?.message || json.error || 'Failed to load config'))
    return (json.config ?? {}) as Record<string, unknown>
}

export async function updateAIOMetadataConfig(
    baseUrl: string,
    uuid: string,
    password: string,
    config: Record<string, unknown>,
    addonPassword?: string
): Promise<void> {
    const res = await fetch('/api/aiometadata-proxy/update', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ baseUrl, uuid, password, config, addonPassword }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(normalizeAuthError(json.error?.message || json.error || 'Failed to update config'))
}

export async function createAIOMetadataUser(
    baseUrl: string,
    password: string,
    config: Record<string, unknown>,
    addonPassword?: string
): Promise<{ uuid: string; installUrl: string }> {
    const res = await fetch('/api/aiometadata-proxy/save', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ baseUrl, password: password.trim(), config, addonPassword }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(normalizeAuthError(json.error?.message || json.error || 'Failed to create config'))
    return { uuid: json.userUUID, installUrl: json.installUrl }
}

// Vault password storage ----------------------------------------------------

export function vaultEntryName(baseUrl: string, uuid: string): string {
    const host = baseUrl.replace(/^https?:\/\//, '')
    const shortUuid = uuid.slice(0, 8)
    return `AIOMetadata · ${host} · ${shortUuid}`
}

export function getStoredAIOMetadataPassword(baseUrl: string, uuid: string): string | null {
    const { keys, isLocked } = useVaultStore.getState()
    if (isLocked) return null
    const structured = keys.find(k => k.provider === 'aiometadata' && k.addonUuid === uuid && k.serverUrl === baseUrl)
    if (structured?.value) return structured.value
    const lookupName = vaultEntryName(baseUrl, uuid)
    const entry = keys.find(k => k.provider === 'aiometadata' && k.name === lookupName)
    return entry?.value ?? null
}

export async function saveAIOMetadataPassword(baseUrl: string, uuid: string, password: string): Promise<void> {
    const lookupName = vaultEntryName(baseUrl, uuid)
    const { keys } = useVaultStore.getState()
    const existing = keys.find(k =>
        k.provider === 'aiometadata' &&
        (k.addonUuid === uuid || k.name === lookupName)
    )
    if (existing) {
        await useVaultStore.getState().updateKey(existing.id, { value: password, serverUrl: baseUrl, addonUuid: uuid })
    } else {
        await useVaultStore.getState().addKey({
            name: lookupName,
            provider: 'aiometadata',
            value: password,
            serverUrl: baseUrl,
            addonUuid: uuid,
        })
    }
}

export async function removeAIOMetadataPassword(baseUrl: string, uuid: string): Promise<void> {
    const lookupName = vaultEntryName(baseUrl, uuid)
    const { keys } = useVaultStore.getState()
    const entry = keys.find(k =>
        k.provider === 'aiometadata' &&
        (k.addonUuid === uuid || k.name === lookupName)
    )
    if (entry) await useVaultStore.getState().removeKey(entry.id)
}

// Config shaping -------------------------------------------------------------

export const AIOMETADATA_SESSION_KEYS = ['sessionId', 'configHash', 'configVersion', 'lastModified']
export const AIOMETADATA_TARGET_LOCAL_KEYS = ['catalogSetupComplete']

export function cloneAIOMetadataConfig(config: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(config))
}

export function sanitizeAIOMetadataConfigForCreate(config: Record<string, unknown>): Record<string, unknown> {
    const next = cloneAIOMetadataConfig(config)
    for (const key of [...AIOMETADATA_SESSION_KEYS, ...AIOMETADATA_TARGET_LOCAL_KEYS]) delete next[key]
    return next
}

type ConfigCategory = 'section' | 'toggle' | 'key' | 'system'

interface KnownSectionMeta {
    label: string
    description: string
    icon: string
}

const KNOWN_SECTIONS: Record<string, KnownSectionMeta> = {
    providers: { label: 'Meta Providers', description: 'Metadata source chosen per content type', icon: 'Database' },
    artProviders: { label: 'Artwork Providers', description: 'Poster, background, and logo source per type', icon: 'Image' },
    apiKeys: { label: 'API Keys', description: 'Tokens for TMDB, TVDB, MAL, AniList, and others', icon: 'KeyRound' },
    catalogs: { label: 'Catalogs', description: 'Configured catalogs surfaced in Stremio', icon: 'LayoutGrid' },
    search: { label: 'Search', description: 'Search engine selection and AI settings', icon: 'Search' },
    mal: { label: 'MyAnimeList', description: 'MyAnimeList-specific behavior', icon: 'ListChecks' },
    tmdb: { label: 'TMDB Options', description: 'TMDB scraping preferences', icon: 'Film' },
    streaming: { label: 'Streaming Providers', description: 'Preferred streaming services', icon: 'Tv' },
    tags: { label: 'Tags', description: 'User-defined content tags', icon: 'Tags' },
    displayTypeOverrides: { label: 'Type Overrides', description: 'Custom manifest type labels', icon: 'Type' },
}

const TOGGLE_KEYS = new Set([
    'includeAdult', 'blurThumbs', 'showPrefix', 'showMetaProviderAttribution', 'displayAgeRating',
    'usePosterProxy', 'enableRatingPostersForLibrary', 'showRateMeButton', 'sfw', 'searchEnabled',
    'catalogModeOnly', 'showDisabledCatalogs',
    'mdblistWatchTracking', 'anilistWatchTracking', 'simklWatchTracking', 'traktWatchTracking', 'publicmetadbWatchTracking',
    'hideUnreleasedDigital', 'hideUnreleasedDigitalSearch', 'hideUnreleasedShows', 'hideUnreleasedShowsSearch',
    'hideWatchedTrakt', 'hideWatchedAnilist', 'hideWatchedMdblist',
])

const SYSTEM_KEYS = new Set([...AIOMETADATA_SESSION_KEYS, 'addonName', 'catalogSetupComplete'])

function categorizeKey(key: string, value: unknown): ConfigCategory {
    if (SYSTEM_KEYS.has(key)) return 'system'
    if (key in KNOWN_SECTIONS) return 'section'
    if (TOGGLE_KEYS.has(key)) return 'toggle'
    if (typeof value === 'boolean') return 'toggle'
    if (value !== null && typeof value === 'object') return 'section'
    return 'key'
}

export interface ConfigSection {
    key: string
    label: string
    description: string
    icon: string
    category: ConfigCategory
    data: unknown
    hasData: boolean
}

export function getConfigSections(config: Record<string, unknown>): ConfigSection[] {
    const sections: ConfigSection[] = []
    for (const [key, value] of Object.entries(config)) {
        const category = categorizeKey(key, value)
        if (category === 'system') continue
        const known = KNOWN_SECTIONS[key]
        sections.push({
            key,
            label: known?.label ?? formatKey(key),
            description: known?.description ?? '',
            icon: known?.icon ?? 'Settings',
            category,
            data: value,
            hasData: value != null && !(Array.isArray(value) && value.length === 0),
        })
    }

    const categoryOrder: ConfigCategory[] = ['section', 'toggle', 'key']
    sections.sort((a, b) => {
        const ai = categoryOrder.indexOf(a.category)
        const bi = categoryOrder.indexOf(b.category)
        if (ai !== bi) return ai - bi
        if (a.category === 'section' && b.category === 'section') {
            const aKnown = a.key in KNOWN_SECTIONS ? 0 : 1
            const bKnown = b.key in KNOWN_SECTIONS ? 0 : 1
            if (aKnown !== bKnown) return aKnown - bKnown
        }
        return a.label.localeCompare(b.label)
    })
    return sections
}

export function getConfigStats(config: Record<string, unknown>): { providers: number; catalogs: number; apiKeys: number; toggles: number } {
    const providers = countEntries(config.providers) + countEntries(config.artProviders)
    const catalogs = Array.isArray(config.catalogs) ? config.catalogs.length : 0
    const apiKeys = countEntries(config.apiKeys, true)
    let toggles = 0
    for (const [key, value] of Object.entries(config)) {
        if (categorizeKey(key, value) === 'toggle' && value === true) toggles++
    }
    return { providers, catalogs, apiKeys, toggles }
}

function countEntries(value: unknown, onlyTruthy = false): number {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return 0
    const entries = Object.values(value as Record<string, unknown>)
    return onlyTruthy ? entries.filter(v => v != null && String(v).trim()).length : entries.length
}

function formatKey(key: string): string {
    return key
        .replace(/([A-Z])/g, ' $1')
        .replace(/[_-]/g, ' ')
        .replace(/^./, c => c.toUpperCase())
        .trim()
}

export function getSectionSummary(key: string, data: unknown): string {
    if (data == null) return 'Not configured'
    switch (key) {
        case 'providers':
        case 'artProviders': {
            const count = countEntries(data)
            return count > 0 ? `${count} type${count !== 1 ? 's' : ''} mapped` : 'Defaults'
        }
        case 'apiKeys': {
            const count = countEntries(data, true)
            return count > 0 ? `${count} key${count !== 1 ? 's' : ''} set` : 'None set'
        }
        case 'catalogs': {
            if (!Array.isArray(data)) return 'Not configured'
            return `${data.length} catalog${data.length !== 1 ? 's' : ''}`
        }
        case 'streaming':
        case 'tags': {
            if (!Array.isArray(data)) return 'Not configured'
            return `${data.length} item${data.length !== 1 ? 's' : ''}`
        }
        case 'search': {
            const s = data as { engine?: string; aiEnabled?: boolean } | null
            if (!s) return 'Not configured'
            return [s.engine, s.aiEnabled ? 'AI' : null].filter(Boolean).join(', ') || 'Enabled'
        }
        default: {
            if (typeof data === 'boolean') return data ? 'Enabled' : 'Disabled'
            if (Array.isArray(data)) return `${data.length} item${data.length !== 1 ? 's' : ''}`
            if (typeof data === 'object') {
                const count = Object.keys(data as Record<string, unknown>).length
                return `${count} propert${count !== 1 ? 'ies' : 'y'}`
            }
            const str = String(data)
            if (str.length === 0) return 'Not configured'
            return str.length > 40 ? `${str.slice(0, 40)}…` : str
        }
    }
}

// Sync groups ----------------------------------------------------------------

export interface SyncGroupDefinition {
    key: string
    label: string
    description: string
    fields: string[]
}

export const AIOMETADATA_SYNC_GROUPS: SyncGroupDefinition[] = [
    { key: 'providers', label: 'Meta & Artwork Providers', description: 'Source selection per content type, plus MAL/TMDB options', fields: ['providers', 'artProviders', 'tvdbSeasonType', 'mal', 'tmdb'] },
    { key: 'apiKeys', label: 'API Keys', description: 'Tokens for TMDB, TVDB, MAL, AniList, and others', fields: ['apiKeys'] },
    { key: 'catalogs', label: 'Catalogs', description: 'Configured catalogs, streaming providers, tags, and type overrides', fields: ['catalogs', 'deletedCatalogs', 'streaming', 'tags', 'displayTypeOverrides', 'showDisabledCatalogs', 'catalogModeOnly'] },
    { key: 'search', label: 'Search', description: 'Search engine and AI settings', fields: ['search', 'searchEnabled'] },
    { key: 'ratings', label: 'Posters & Ratings', description: 'Poster service, proxy, rating posters, and custom URL patterns', fields: ['posterRatingProvider', 'usePosterProxy', 'enableRatingPostersForLibrary', 'showRateMeButton', 'blurThumbs', 'customPosterUrlPattern', 'customBackgroundUrlPattern', 'customLogoUrlPattern', 'customThumbnailUrlPattern'] },
    { key: 'watchTracking', label: 'Watch Tracking', description: 'MDBList, AniList, Simkl, Trakt, and PublicMetaDB sync', fields: ['mdblistWatchTracking', 'anilistWatchTracking', 'simklWatchTracking', 'traktWatchTracking', 'publicmetadbWatchTracking', 'hideWatchedTrakt', 'hideWatchedAnilist', 'hideWatchedMdblist'] },
    { key: 'filtering', label: 'Content Filtering', description: 'Adult/SFW, age rating, and exclusion rules', fields: ['includeAdult', 'sfw', 'ageRating', 'exclusionKeywords', 'regexExclusionFilter', 'exclusionGenres', 'hideUnreleasedDigital', 'hideUnreleasedDigitalSearch', 'hideUnreleasedShows', 'hideUnreleasedShowsSearch'] },
    { key: 'display', label: 'Display', description: 'Language, prefixes, attribution, cast count, and age rating display', fields: ['language', 'showPrefix', 'showMetaProviderAttribution', 'castCount', 'displayAgeRating'] },
]

// Branding is the AIOManager-facing identity; offered separately so targets keep their own name.
export const AIOMETADATA_BRANDING_KEYS = ['addonName']

export function getSyncGroupFields(key: string): string[] {
    return AIOMETADATA_SYNC_GROUPS.find(g => g.key === key)?.fields ?? [key]
}

export function hasSyncGroupData(config: Record<string, unknown>, key: string): boolean {
    return getSyncGroupFields(key).some(field => config[field] !== undefined && config[field] !== null)
}

export function getSyncGroupSummary(config: Record<string, unknown>, key: string): string {
    const group = AIOMETADATA_SYNC_GROUPS.find(g => g.key === key)
    if (!group) return getSectionSummary(key, config[key])
    if (group.fields.length === 1) return getSectionSummary(group.fields[0], config[group.fields[0]])
    const configured = group.fields.filter(field => config[field] !== undefined && config[field] !== null)
    if (configured.length === 0) return 'Not configured'
    if (key === 'catalogs') return getSectionSummary('catalogs', config.catalogs)
    if (key === 'apiKeys') return getSectionSummary('apiKeys', config.apiKeys)
    return `${configured.length} setting${configured.length !== 1 ? 's' : ''}`
}
