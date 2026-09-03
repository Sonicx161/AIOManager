import { AddonDescriptor } from '@/types/addon'
import { useVaultStore } from '@/store/vaultStore'
import { useSyncStore } from '@/store/syncStore'
import { deriveSyncToken } from '@/lib/crypto'
import { useAccountStore } from '@/store/accountStore'
import { getAIOStreamsConfigureUrl, parseAIOStreamsUrl } from './aiostreams-url.ts'

export { getAIOStreamsConfigureUrl, parseAIOStreamsUrl }

const AIOSTREAMS_MANIFEST_IDS = [
    'community.aiostreams',
    'aiostreams',
]

export function isAIOStreamsAddon(addon: AddonDescriptor): boolean {
    if (!addon) return false
    const id = addon.manifest?.id?.toLowerCase() || ''
    const name = addon.manifest?.name?.toLowerCase() || ''
    if (AIOSTREAMS_MANIFEST_IDS.some(k => id.includes(k))) return true
    if (name === 'aiostreams') return true
    return false
}


export async function fetchAIOStreamsUser(
    baseUrl: string,
    uuid: string,
    password: string
): Promise<{ userData: Record<string, unknown>; encryptedPassword: string }> {
    const auth = useSyncStore.getState().auth
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (auth.isAuthenticated) {
        headers['x-sync-user'] = auth.id
        headers['x-sync-password'] = await deriveSyncToken(auth.password)
    }
    const res = await fetch('/api/aiostreams-proxy/user', {
        method: 'POST',
        headers,
        body: JSON.stringify({ baseUrl, uuid, password }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(json.error?.message || 'Failed to fetch user')
    return json.data
}

function withAccessKey(config: Record<string, unknown>, accessKey: string): Record<string, unknown> {
    return { ...config, accessKey }
}

export async function updateAIOStreamsUser(
    baseUrl: string,
    uuid: string,
    password: string,
    config: Record<string, unknown>
): Promise<void> {
    const auth = useSyncStore.getState().auth
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (auth.isAuthenticated) {
        headers['x-sync-user'] = auth.id
        headers['x-sync-password'] = await deriveSyncToken(auth.password)
    }
    const res = await fetch('/api/aiostreams-proxy', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ baseUrl, uuid, password, config: withAccessKey(config, password) }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(json.error?.message || 'Failed to update user')
}

export async function createAIOStreamsUser(
    baseUrl: string,
    password: string,
    config: Record<string, unknown>
): Promise<{ uuid: string; encryptedPassword: string }> {
    const auth = useSyncStore.getState().auth
    const createPassword = password.trim()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (auth.isAuthenticated) {
        headers['x-sync-user'] = auth.id
        headers['x-sync-password'] = await deriveSyncToken(auth.password)
    }
    const res = await fetch('/api/aiostreams-proxy', {
        method: 'POST',
        headers,
        body: JSON.stringify({ baseUrl, password: createPassword, config: withAccessKey(config, createPassword) }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(json.error?.message || 'Failed to create user')
    return json.data
}

export async function deleteAIOStreamsUser(
    baseUrl: string,
    uuid: string,
    password: string
): Promise<void> {
    const auth = useSyncStore.getState().auth
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (auth.isAuthenticated) {
        headers['x-sync-user'] = auth.id
        headers['x-sync-password'] = await deriveSyncToken(auth.password)
    }
    const res = await fetch('/api/aiostreams-proxy', {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ baseUrl, uuid, password }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(json.error?.message || 'Failed to delete user')
}

export async function fetchAIOStreamsStatus(
    baseUrl: string
): Promise<Record<string, unknown> | null> {
    try {
        const auth = useSyncStore.getState().auth
        const headers: Record<string, string> = {}
        if (auth.isAuthenticated) {
            headers['x-sync-user'] = auth.id
            headers['x-sync-password'] = await deriveSyncToken(auth.password)
        }
        const params = new URLSearchParams({ baseUrl })
        const res = await fetch(`/api/aiostreams-status?${params}`, { headers })
        const json = await res.json()
        if (!json.success) return null
        return json.data
    } catch {
        return null
    }
}

export const SERVICE_VAULT_MAP: Record<string, string> = {
    realdebrid: 'real-debrid',
    premiumize: 'premiumize',
    torbox: 'torbox',
    alldebrid: 'alldebrid',
    debridlink: 'debrid-link',
    putio: 'other',
    easydebrid: 'other',
    offcloud: 'other',
    pikpak: 'other',
}

export function getVaultProviderForService(serviceId: string): string | null {
    return SERVICE_VAULT_MAP[serviceId.toLowerCase()] ?? null
}

export const AIOSTREAMS_RUNTIME_CONFIG_KEYS = [
    'uuid', 'encryptedPassword', 'trusted', 'ip', 'accessToken',
]

export const AIOSTREAMS_TARGET_LOCAL_CONFIG_KEYS = [
    'appliedTemplates',
    'accessKey',
]

export const AIOSTREAMS_PARENT_CONFIG_KEYS = [
    'parentConfig', 'parentConfigUuid', 'parentConfigPassword',
    'parentConfigMergeStrategy', 'parentMergeStrategy',
]

export function cloneAIOStreamsConfig(config: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(config))
}

export function sanitizeAIOStreamsConfigForCreate(config: Record<string, unknown>): Record<string, unknown> {
    const next = cloneAIOStreamsConfig(config)
    for (const key of AIOSTREAMS_RUNTIME_CONFIG_KEYS) delete next[key]
    for (const key of AIOSTREAMS_TARGET_LOCAL_CONFIG_KEYS) delete next[key]
    for (const key of AIOSTREAMS_PARENT_CONFIG_KEYS) delete next[key]
    return next
}

export function sanitizeAIOStreamsConfigForUpdate(config: Record<string, unknown>): Record<string, unknown> {
    const next = cloneAIOStreamsConfig(config)
    for (const key of AIOSTREAMS_RUNTIME_CONFIG_KEYS) delete next[key]
    return next
}

const SYSTEM_KEYS = new Set([
    ...AIOSTREAMS_RUNTIME_CONFIG_KEYS,
    'accessKey',
    'showChanges',
])

const BRANDING_KEYS = new Set([
    'addonName', 'addonLogo', 'addonBackground', 'addonDescription',
])

type ConfigCategory = 'section' | 'filter' | 'toggle' | 'key' | 'system' | 'branding'

interface KnownSectionMeta {
    label: string
    description: string
    icon: string
    editor?: 'posterService' | 'statistics' | 'deduplicator' | 'proxy' | 'formatter'
    complex?: boolean
}

const KNOWN_SECTIONS: Record<string, KnownSectionMeta> = {
    formatter:       { label: 'Custom Formatter', description: 'Customize how stream titles appear in Stremio', icon: 'Zap', editor: 'formatter' },
    sortCriteria:    { label: 'Sorting', description: 'Define sort order for movies, series, anime, and cached/uncached results', icon: 'ArrowUpDown', complex: true },
    groups:          { label: 'Groups', description: 'Organize addons into groups with custom fetch behavior', icon: 'FolderOpen', complex: true },
    services:        { label: 'Services', description: 'Debrid services and their API credentials', icon: 'Tv', complex: true },
    deduplicator:    { label: 'Deduplication', description: 'Control how duplicate streams are detected and removed', icon: 'Layers', editor: 'deduplicator' },
    proxy:           { label: 'Proxy', description: 'Route streams through a proxy to bypass IP restrictions', icon: 'Shield', editor: 'proxy' },
    presets:         { label: 'Addons', description: 'Manage addon configurations and marketplace addons', icon: 'Bookmark', complex: true },
    posterService:   { label: 'Poster Service', description: 'Choose a poster provider for enhanced catalog artwork', icon: 'Image', editor: 'posterService' },
    statistics:      { label: 'Statistics', description: 'Show filter results and timing info in stream titles', icon: 'BarChart3', editor: 'statistics' },
    digitalReleaseFilter: { label: 'Digital Release Filter', description: 'Filter streams based on digital release dates', icon: 'Calendar' },
    dynamicAddonFetching: { label: 'Dynamic Fetching', description: 'Conditionally fetch results from addons', icon: 'RefreshCw' },
    yearMatching:    { label: 'Year Matching', description: 'Match streams by year with tolerance', icon: 'Hash' },
    titleMatching:   { label: 'Title Matching', description: 'Match streams by title similarity', icon: 'Type' },
    seasonEpisodeMatching: { label: 'Season/Episode Matching', description: 'Match streams by season and episode numbers', icon: 'List' },
    autoPlay:        { label: 'Auto Play', description: 'Automatically play the best result', icon: 'Play' },
    areYouStillThere: { label: 'Still Watching', description: 'Periodic check during long playback sessions', icon: 'Clock' },
    preloadStreams:  { label: 'Preload Streams', description: 'Preload next episode streams', icon: 'FastForward' },
    nzbFailover:     { label: 'NZB Failover', description: 'Fallback behavior for failed NZB downloads', icon: 'RotateCw' },
    serviceWrap:     { label: 'Service Wrap', description: 'Wrap addon results with service configurations', icon: 'WrapText' },
    resultLimits:    { label: 'Result Limits', description: 'Limit results by category', icon: 'Gauge' },
    size:            { label: 'Size Filters', description: 'Filter streams by file size', icon: 'HardDrive' },
    bitrate:         { label: 'Bitrate Filters', description: 'Filter streams by bitrate', icon: 'Activity' },
    cacheAndPlay:    { label: 'Cache and Play', description: 'Cache streams for immediate playback', icon: 'Database' },
}

const FILTER_PREFIXES = ['excluded', 'included', 'required', 'preferred']

const TOGGLE_KEYS = new Set([
    'randomiseResults', 'enhanceResults', 'enhancePosters', 'enableSeadex',
    'excludeSeasonPacks', 'hideErrors', 'externalDownloads', 'autoRemoveDownloads',
    'usePosterRedirectApi', 'usePosterServiceForMeta', 'precacheNextEpisode',
    'precacheSingleStream', 'checkOwned', 'excludeCached', 'excludeUncached',
])

const API_KEY_KEYS = new Set([
    'rpdbApiKey', 'topPosterApiKey', 'aioratingsApiKey', 'aioratingsProfileId',
    'openposterdbApiKey', 'openposterdbUrl', 'tmdbAccessToken', 'tmdbApiKey',
    'tvdbApiKey', 'precacheSelector',
])

function categorizeKey(key: string, value: unknown): ConfigCategory {
    if (SYSTEM_KEYS.has(key)) return 'system'
    if (BRANDING_KEYS.has(key)) return 'branding'
    if (key in KNOWN_SECTIONS) return 'section'
    if (FILTER_PREFIXES.some(p => key.startsWith(p))) return 'filter'
    if (TOGGLE_KEYS.has(key)) return 'toggle'
    if (API_KEY_KEYS.has(key)) return 'key'
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return 'section'
    if (typeof value === 'boolean') return 'toggle'
    if (Array.isArray(value)) return 'filter'
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
    editor?: KnownSectionMeta['editor']
    complex?: boolean
}

export function getConfigSections(config: Record<string, unknown>): ConfigSection[] {
    const sections: ConfigSection[] = []

    for (const [key, value] of Object.entries(config)) {
        const category = categorizeKey(key, value)
        if (category === 'system' || category === 'branding') continue

        const known = KNOWN_SECTIONS[key]
        const hasData = value != null

        sections.push({
            key,
            label: known?.label ?? formatKey(key),
            description: known?.description ?? '',
            icon: known?.icon ?? 'Settings',
            category,
            data: value,
            hasData,
            editor: known?.editor,
            complex: known?.complex,
        })
    }

    const categoryOrder: ConfigCategory[] = ['section', 'toggle', 'filter', 'key']
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

export function getConfigStats(config: Record<string, unknown>): { sections: number; filters: number; toggles: number; keys: number; total: number } {
    let sections = 0, filters = 0, toggles = 0, keys = 0
    for (const [key, value] of Object.entries(config)) {
        const cat = categorizeKey(key, value)
        if (cat === 'system' || cat === 'branding') continue
        if (cat === 'section') sections++
        else if (cat === 'filter') filters++
        else if (cat === 'toggle') toggles++
        else keys++
    }
    return { sections, filters, toggles, keys, total: sections + filters + toggles + keys }
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
        case 'formatter': {
            const f = data as { id?: string; definition?: { name?: string } } | null
            if (!f?.id) return 'Not configured'
            if (f.id === 'custom' && f.definition?.name) return 'Custom'
            return f.id.charAt(0).toUpperCase() + f.id.slice(1)
        }
        case 'sortCriteria': {
            const s = data as { global?: { key: string; direction: string }[] } | null
            if (!s?.global?.length) return 'Not configured'
            const arrows: Record<string, string> = { asc: '↑', desc: '↓' }
            return s.global.map(c => `${formatKey(c.key)} ${arrows[c.direction] || ''}`).join(', ')
        }
        case 'groups': {
            const g = data as { enabled?: boolean; groupings?: unknown[]; behaviour?: string } | null
            if (!g) return 'Not configured'
            const count = g.groupings?.length ?? 0
            if (!count) return g.enabled === false ? 'Disabled' : 'No groups'
            return `${count} group${count !== 1 ? 's' : ''}${g.behaviour ? ` (${g.behaviour})` : ''}`
        }
        case 'services': {
            const svcs = data as { id: string; enabled?: boolean }[] | null
            if (!Array.isArray(svcs) || svcs.length === 0) return 'Not configured'
            return svcs.map(s => formatKey(s.id)).join(', ')
        }
        case 'deduplicator': {
            const d = data as { enabled?: boolean; cached?: string; uncached?: string } | null
            if (!d) return 'Not configured'
            if (d.enabled === false) return 'Disabled'
            const modes: string[] = [d.cached, d.uncached].filter((m): m is string => !!m)
            if (modes.length) return modes.map(formatKey).join(', ')
            return 'Enabled'
        }
        case 'proxy': {
            const p = data as { enabled?: boolean; id?: string; url?: string } | null
            if (!p) return 'Not configured'
            if (p.enabled === false) return 'Disabled'
            if (p.url) return 'Custom proxy'
            if (p.id) return formatKey(p.id)
            return p.enabled ? 'Enabled' : 'Not configured'
        }
        case 'presets': {
            const presets = data as { type: string; name?: string; enabled?: boolean }[] | null
            if (!Array.isArray(presets) || presets.length === 0) return 'Not configured'
            const names = presets.map(p => p.name || formatKey(p.type))
            if (names.length <= 3) return names.join(', ')
            return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`
        }
        case 'posterService': {
            if (typeof data !== 'string') return 'Not configured'
            const map: Record<string, string> = { rpdb: 'RPDB', 'top-poster': 'Top Poster', aioratings: 'AIO Ratings', openposterdb: 'OpenPosterDB', none: 'None' }
            return map[data] || formatKey(data)
        }
        case 'statistics': {
            const st = data as { enabled?: boolean; position?: string; statsToShow?: string[] } | null
            if (!st) return 'Not configured'
            if (st.enabled === false) return 'Disabled'
            const pos = st.position ? ` - ${st.position}` : ''
            return `Enabled${pos}`
        }
        default: {
            if (typeof data === 'boolean') return data ? 'Enabled' : 'Disabled'
            if (Array.isArray(data)) return `${data.length} item${data.length !== 1 ? 's' : ''}`
            if (typeof data === 'object') {
                const keys = Object.keys(data as Record<string, unknown>)
                return `${keys.length} propert${keys.length !== 1 ? 'ies' : 'y'}`
            }
            if (typeof data === 'string') {
                if (data.length === 0) return 'Not configured'
                if (data.length > 40) return `${data.slice(0, 40)}…`
                return data
            }
            return String(data)
        }
    }
}

export function vaultEntryName(baseUrl: string, uuid: string): string {
    const host = baseUrl.replace(/^https?:\/\//, '')
    const shortUuid = uuid.slice(0, 8)
    return `AIOStreams · ${host} · ${shortUuid}`
}

export async function migrateAIOStreamsVaultNames(): Promise<void> {
    const store = useVaultStore.getState()
    if (store.isLocked) return
    const legacy = store.keys.filter(
        k => k.provider === 'aiostreams' && k.name.startsWith('AIOStreams:http')
    )
    for (const entry of legacy) {
        const rest = entry.name.slice('AIOStreams:'.length)
        const lastColon = rest.lastIndexOf(':')
        if (lastColon === -1) continue
        const oldBaseUrl = rest.slice(0, lastColon)
        const oldUuid = rest.slice(lastColon + 1)
        if (!oldUuid || oldUuid.length < 8) continue
        const newName = vaultEntryName(oldBaseUrl, oldUuid)
        if (newName !== entry.name) {
            await store.updateKey(entry.id, { name: newName, serverUrl: oldBaseUrl, addonUuid: oldUuid })
        }
    }
    const unstructured = store.keys.filter(
        k => k.provider === 'aiostreams' && !k.serverUrl &&
            /^AIOStreams · (.+?) · (.+)$/.test(k.name)
    )
    if (unstructured.length > 0) {
        const instanceUuids = collectInstalledUuids()
        for (const entry of unstructured) {
            const match = entry.name.match(/^AIOStreams · (.+?) · (.+)$/)
            if (!match) continue
            const host = match[1]
            const shortUuid = match[2]
            const fullUuid = instanceUuids.get(`${host}|${shortUuid}`)
            await useVaultStore.getState().updateKey(entry.id, {
                serverUrl: `https://${host}`,
                ...(fullUuid ? { addonUuid: fullUuid } : {}),
            })
        }
    }
}

function collectInstalledUuids(): Map<string, string> {
    const byHostShort = new Map<string, string>()
    const { accounts } = useAccountStore.getState()
    for (const account of accounts) {
        for (const addon of account.addons || []) {
            const parsed = parseAIOStreamsUrl(addon.transportUrl)
            if (!parsed) continue
            const host = parsed.baseUrl.replace(/^https?:\/\//, '')
            byHostShort.set(`${host}|${parsed.uuid.slice(0, 8)}`, parsed.uuid)
        }
    }
    return byHostShort
}

export function getStoredAIOStreamsPassword(baseUrl: string, uuid: string): string | null {
    const { keys, isLocked } = useVaultStore.getState()
    if (isLocked) return null
    const structured = keys.find(k => k.provider === 'aiostreams' && k.addonUuid === uuid && k.serverUrl === baseUrl)
    if (structured?.value) return structured.value
    const lookupName = vaultEntryName(baseUrl, uuid)
    const entry = keys.find(k => k.provider === 'aiostreams' && k.name === lookupName)
    if (entry?.value) return entry.value
    const host = baseUrl.replace(/^https?:\/\//, '')
    const candidates = keys.filter(k =>
        k.provider === 'aiostreams' &&
        k.name.startsWith(`AIOStreams · ${host} ·`) &&
        k.name !== lookupName
    )
    if (candidates.length === 1) return candidates[0].value ?? null
    return null
}

export async function saveAIOStreamsPassword(baseUrl: string, uuid: string, password: string): Promise<void> {
    const lookupName = vaultEntryName(baseUrl, uuid)
    const { keys } = useVaultStore.getState()
    const existing = keys.find(k =>
        k.provider === 'aiostreams' &&
        (k.addonUuid === uuid || k.name === lookupName)
    )
    if (existing) {
        await useVaultStore.getState().updateKey(existing.id, { value: password, serverUrl: baseUrl, addonUuid: uuid })
    } else {
        await useVaultStore.getState().addKey({
            name: lookupName,
            provider: 'aiostreams',
            value: password,
            serverUrl: baseUrl,
            addonUuid: uuid,
        })
    }
}

export async function removeAIOStreamsPassword(baseUrl: string, uuid: string): Promise<void> {
    const lookupName = vaultEntryName(baseUrl, uuid)
    const { keys } = useVaultStore.getState()
    const entry = keys.find(k =>
        k.provider === 'aiostreams' &&
        (k.addonUuid === uuid || k.name === lookupName)
    )
    if (entry) {
        await useVaultStore.getState().removeKey(entry.id)
    }
}

export const PREDEFINED_FORMATTERS = [
    { id: 'torrentio', label: 'Torrentio', description: 'Classic format with resolution, tags, and service info' },
    { id: 'torbox', label: 'TorBox', description: 'Clean format with quality, size, and language details' },
    { id: 'gdrive', label: 'GDrive', description: 'Detailed format with emojis for quality, tags, and technical info' },
    { id: 'light-gdrive', label: 'Light GDrive', description: 'Compact GDrive variant with title and essential info' },
    { id: 'minimalistic-gdrive', label: 'Minimalistic', description: 'Ultra-minimal resolution and quality only' },
    { id: 'prism', label: 'Prism', description: 'Resolution-focused with comprehensive technical breakdown' },
    { id: 'tamtaro', label: 'Tamtaro', description: 'Unicode-styled with small caps and detailed metadata' },
] as const
