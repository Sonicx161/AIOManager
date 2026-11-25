import { maskUrlLevel } from './utils.ts'

export interface NuvioMediaServerView {
    key: string
    name: string
    type: string
    host: string
}

export interface NuvioHomeRowView {
    key: string
    title: string
    source: string
    hidden: boolean
}

export type NuvioAppSetupRead<T> = { shared: false } | { shared: true; items: T[] }

interface CatalogEntry {
    addonName: string
    catalogName: string
}

export type CatalogDirectory = { addons: Map<string, string>; catalogs: Map<string, CatalogEntry> }

const PROVIDER_LABEL: Record<string, string> = { jellyfin: 'Jellyfin', emby: 'Emby' }

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

function jsonValue(v: unknown): unknown {
    if (typeof v !== 'string') return v
    try { return JSON.parse(v) } catch { return null }
}

function firstRow(rows: unknown): Record<string, unknown> | null {
    const row = Array.isArray(rows) ? rows[0] : rows
    return row && typeof row === 'object' ? row as Record<string, unknown> : null
}

export function maskServerHost(address: string): string {
    const raw = str(address)
    if (!raw) return ''
    const masked = maskUrlLevel(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`, 2)
    return masked.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/\*\*\*$/, '')
}

// A name typed as a URL, host name or IP address is shown masked like the address.
function looksLikeAddress(name: string): boolean {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(name) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(name)
}

function providerLabel(id: string): string {
    return PROVIDER_LABEL[id.toLowerCase()] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Media server')
}

export function mapMediaServers(rows: unknown): NuvioMediaServerView[] {
    const list = jsonValue(firstRow(rows)?.servers_json)
    if (!Array.isArray(list)) return []
    return list.flatMap((entry, i) => {
        if (!entry || typeof entry !== 'object') return []
        const s = entry as Record<string, unknown>
        const type = providerLabel(str(s.provider_id))
        const name = str(s.name)
        return [{ key: str(s.id) || String(i), name: looksLikeAddress(name) ? maskServerHost(name) : name || type, type, host: maskServerHost(str(s.address)) }]
    })
}

export function catalogDirectory(addons: ReadonlyArray<{ manifest?: { id?: string; name?: string; catalogs?: ReadonlyArray<{ type?: string; id?: string; name?: string }> } | null }>): CatalogDirectory {
    const dir: CatalogDirectory = { addons: new Map(), catalogs: new Map() }
    for (const addon of addons) {
        const m = addon.manifest
        const id = str(m?.id)
        if (!id) continue
        const addonName = str(m?.name) || id
        if (!dir.addons.has(id)) dir.addons.set(id, addonName)
        for (const c of m?.catalogs || []) {
            const key = `${id}:${str(c.type)}:${str(c.id)}`
            if (!dir.catalogs.get(key)?.catalogName) dir.catalogs.set(key, { addonName, catalogName: str(c.name) })
        }
    }
    return dir
}

export function mapHomeLayout(rows: unknown, dir: CatalogDirectory): NuvioHomeRowView[] {
    const settings = jsonValue(firstRow(rows)?.settings_json) as { items?: unknown } | null
    const items = Array.isArray(settings?.items) ? settings.items : []
    return items
        .map((entry, i) => ({ item: (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>, i }))
        .sort((a, b) => (Number(a.item.order) || 0) - (Number(b.item.order) || 0) || a.i - b.i)
        .map(({ item, i }) => {
            const addonId = str(item.addon_id)
            const catalogId = str(item.catalog_id)
            const known = dir.catalogs.get(`${addonId}:${str(item.type)}:${catalogId}`)
            const hidden = item.enabled === false
            const isCollection = item.is_collection === true
            const type = str(item.type)
            const unnamed = catalogId ? (type ? `${catalogId} (${type})` : catalogId) : 'Catalog'
            const title = str(item.custom_title) || known?.catalogName || (isCollection ? 'Collection' : unnamed)
            const source = hidden ? 'Hidden' : known?.addonName || dir.addons.get(addonId) || ''
            return { key: str(item.key) || `${addonId}:${str(item.type)}:${catalogId}:${i}`, title, source, hidden }
        })
}

export function isUnsupportedNuvioRead(err: unknown): boolean {
    return (err as { status?: unknown } | null)?.status === 404
}
