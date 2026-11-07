// Pure display helpers for the addon card. Relative .ts imports keep them runnable under node:test.
import { identifyAddon } from '../../lib/addon-identifier.ts'
import { normalizeAddonUrl } from '../../lib/addon-url.ts'

// URL box text only: input must already be secret-masked. Drops the scheme and manifest suffix and
// collapses the masker's "..." into one ellipsis so CSS truncation never adds a second.
export function compactAddonUrl(maskedUrl: string): string {
    if (!maskedUrl) return maskedUrl
    return maskedUrl
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
        .replace(/\/manifest\.json(?=$|[?#])/i, '')
        .replace(/\/+(?=$|[?#])/, '')
        .replace(/\.\.\./g, '…')
}

export interface AddonProperties {
    official?: boolean
    patched?: boolean
    protected?: boolean
    configureHidden?: boolean
}

// One muted menu line replacing the standing property badges, e.g. "Official, patched, protected".
export function addonPropertySummary(props: AddonProperties): string | null {
    const parts: string[] = []
    if (props.official) parts.push('official')
    if (props.patched) parts.push('patched')
    if (props.protected) parts.push('protected')
    if (props.configureHidden) parts.push('configure hidden')
    if (parts.length === 0) return null
    const line = parts.join(', ')
    return line.charAt(0).toUpperCase() + line.slice(1)
}

export interface AutopilotRoleInput {
    isPrimary?: boolean
    isPrimaryPaused?: boolean
    failoverPrimaryName?: string
    failoverPaused?: boolean
}

export interface AutopilotRole {
    role: 'primary' | 'backup'
    paused: boolean
    label: string
    detail: string
}

// At most one Autopilot chip per card; primary wins when an addon is both.
export function autopilotRole(input: AutopilotRoleInput): AutopilotRole | null {
    if (input.isPrimary) {
        const paused = !!input.isPrimaryPaused
        return {
            role: 'primary',
            paused,
            label: paused ? 'Autopilot primary (paused)' : 'Autopilot primary',
            detail: `Autopilot keeps this addon active while it passes health checks and switches to a backup if it fails.${paused ? ' This rule is paused.' : ''}`,
        }
    }
    if (input.failoverPrimaryName) {
        const paused = !!input.failoverPaused
        return {
            role: 'backup',
            paused,
            label: paused ? 'Autopilot backup (paused)' : 'Autopilot backup',
            detail: `Takes over for ${input.failoverPrimaryName} if it fails a health check.${paused ? ' This rule is paused.' : ''}`,
        }
    }
    return null
}

interface LogoSource {
    transportUrl?: string
    installUrl?: string
    manifest?: { id?: string; name?: string; logo?: string } | null
}

export type AddonLogoIndex = Map<string, string>

const USABLE_LOGO = /^(https?:|data:image\/)/i

function usableLogo(logo: unknown): string | undefined {
    return typeof logo === 'string' && USABLE_LOGO.test(logo.trim()) ? logo.trim() : undefined
}

const urlKey = (url: string) => `url:${normalizeAddonUrl(url)}`
const idKey = (id: string) => `id:${id.trim().toLowerCase()}`

// Manifest logos of every other copy of each addon (other accounts, saved library), keyed by URL and manifest id.
export function buildAddonLogoIndex(sources: Iterable<LogoSource>): AddonLogoIndex {
    const index: AddonLogoIndex = new Map()
    for (const source of sources) {
        const logo = usableLogo(source.manifest?.logo)
        if (!logo) continue
        const url = source.transportUrl || source.installUrl
        if (url && !index.has(urlKey(url))) index.set(urlKey(url), logo)
        const id = source.manifest?.id
        if (id && !index.has(idKey(id))) index.set(idKey(id), logo)
    }
    return index
}

interface LogoTarget {
    transportUrl: string
    manifest: { id?: string; name?: string; logo?: string }
    metadata?: { customLogo?: string }
}

// Custom logo, then manifest logo, then the same addon elsewhere, then the known-logo list.
export function resolveAddonLogo(addon: LogoTarget, index?: AddonLogoIndex | null): string | undefined {
    const own = addon.metadata?.customLogo || addon.manifest?.logo
    if (own) return own
    if (index) {
        const byUrl = addon.transportUrl ? index.get(urlKey(addon.transportUrl)) : undefined
        if (byUrl) return byUrl
        const byId = addon.manifest?.id ? index.get(idKey(addon.manifest.id)) : undefined
        if (byId) return byId
    }
    return usableLogo(identifyAddon(addon.transportUrl || '', { id: addon.manifest?.id, name: addon.manifest?.name }).logo)
}

// First line of a markdown sticky note as plain text, for the card's one-line note preview.
export function notePreview(note?: string | null): string {
    if (!note) return ''
    const line = note.split('\n').map(l => l.trim()).find(Boolean) || ''
    return line
        .replace(/^(?:[-*+]|\d+\.)\s+/, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/\*(\S(?:.*?\S)?)\*/g, '$1')
        .replace(/`([^`]*)`/g, '$1')
        .trim()
}
