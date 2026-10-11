import { addonEndpointUrl } from './addon-endpoint-url'
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { AddonDescriptor } from '@/types/addon'
// Imported relative-with-extension (not via the @/ alias) so this module stays
// resolvable under the node:test runner, which does not map path aliases.
import { getHostnameIdentifier } from './addon-identifier.ts'
import { normalizeAddonUrl as _normalizeAddonUrl } from './addon-url.ts'
import { trace } from './trace.ts'
import { claimInstanceRemotes } from './addon-instance-identity.ts'

const NON_ALPHANUMERIC_REGEX = /[^a-z0-9]/g
const CANONICAL_URL_CACHE = new Map<string, string>()
const CANONICAL_URL_CACHE_MAX_SIZE = 500

const normalizeAddonUrl = (url: string): string => {
  const cached = CANONICAL_URL_CACHE.get(url)
  if (cached !== undefined) return cached

  const result = _normalizeAddonUrl(url)

  if (CANONICAL_URL_CACHE.size >= CANONICAL_URL_CACHE_MAX_SIZE) {
    const oldestKey = CANONICAL_URL_CACHE.keys().next().value
    if (oldestKey !== undefined) CANONICAL_URL_CACHE.delete(oldestKey)
  }

  CANONICAL_URL_CACHE.set(url, result)
  return result
}

export { normalizeAddonUrl }

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getSyncScopeLabel(syncAccountIds: string[] | null | undefined): string {
  if (!syncAccountIds || syncAccountIds === null) {
    return `All accounts`
  }
  if (syncAccountIds.length === 0) {
    return `No accounts`
  }
  return `${syncAccountIds.length} account${syncAccountIds.length !== 1 ? 's' : ''}`
}

export function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return email
  const [local, domain] = email.split('@')
  if (local.length <= 3) return `***@${domain}`
  return `${local.substring(0, 3)}***@${domain}`
}

export function maskEmailLevel(email: string, level: number): string {
  if (level <= 0 || !email || !email.includes('@')) return email
  const [local, domain] = email.split('@')
  if (level === 1) {
    if (local.length <= 3) return `***@${domain}`
    return `${local.substring(0, 3)}***@${domain}`
  }
  if (level === 2) {
    const maskedLocal = local.length > 1 ? `${local[0]}***${local[local.length - 1]}` : '***'
    const domainParts = domain.split('.')
    if (domainParts.length > 1) {
      const maskedDomain = `${domainParts[0][0]}***${domainParts[0][domainParts[0].length - 1] || ''}.${domainParts.slice(1).map(p => p[0] + '***').join('.')}`
      return `${maskedLocal}@${maskedDomain}`
    }
    return `${maskedLocal}@${domain[0]}***`
  }
  return '****'
}

export function maskNameLevel(name: string, level: number): string {
  if (level <= 0 || !name) return name
  if (level === 1) {
    if (name.length <= 3) return name[0] + '***'
    return `${name.substring(0, 3)}***`
  }
  if (level === 2) {
    if (name.length <= 1) return '*'
    return `${name[0]}***${name[name.length - 1]}`
  }
  return '****'
}

export function maskUrlLevel(url: string, level: number): string {
  if (level <= 0 || !url) return url
  try {
    const urlObj = new URL(url)
    if (level === 1) {
      return `${urlObj.protocol}//${urlObj.hostname}/...`
    }
    if (level === 2) {
      const parts = urlObj.hostname.split('.')
      if (parts.length > 1) {
        return `${urlObj.protocol}//${parts[0]}.${parts.slice(1).map(p => '*'.repeat(p.length)).join('.')}/***`
      }
      return `${urlObj.protocol}//${'*'.repeat(urlObj.hostname.length)}/***`
    }
    return '********'
  } catch {
    return '********'
  }
}

export function maskProfileLevel(profileName: string, level: number, count?: number): string {
  if (level <= 0 || !profileName) return profileName
  if (level === 1) {
    if (profileName.length <= 1) return '*'
    return `${profileName[0]}***${profileName[profileName.length - 1]}`
  }
  if (level === 2) {
    return count != null ? `${count} profile${count !== 1 ? 's' : ''}` : '****'
  }
  return '****'
}

export function getStremioLink(url: string): string {
  return url.replace(/^https?:\/\//, 'stremio://')
}

/**
 * Robustly opens a Stremio detail page.
 * Tries deep link first, then falls back to web.stremio.com for a better web/mobile experience.
 */
export function openStremioDetail(type: string, id: string) {
  const normalizedType = type === 'anime' ? 'series' : type
  const deepLink = `stremio:///detail/${normalizedType}/${id}`
  const webLink = `https://web.stremio.com/#/detail/${normalizedType}/${id}`

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

  if (isMobile) {
    window.location.href = deepLink
    return
  }

  const start = Date.now()
  let blurred = false

  const onBlur = () => { blurred = true }
  window.addEventListener('blur', onBlur)

  window.location.href = deepLink

  setTimeout(() => {
    window.removeEventListener('blur', onBlur)
    if (!blurred && (Date.now() - start < 1000)) {
      window.open(webLink, '_blank')
    }
  }, 500)
}

export function getAddonConfigureUrl(installUrl: string): string {
  try { return addonEndpointUrl(installUrl, 'configure') } catch { return installUrl }
}

/**
 * Normalizes an addon URL for consistent comparison.
 * Handles stremio:// protocols, trailing slashes, manifest.json suffixes, and lowercases the result.
 */

/**
 * Strips user-specific UUID segments (20+ chars, hex/hyphen) from the path.
 * This ensures that multiple configs of the same self-hosted addon are grouped.
 */
export function getCanonicalAddonUrl(url: string): string {
  const normalized = normalizeAddonUrl(url)
  try {
    const urlObj = new URL(normalized.startsWith('http') ? normalized : `https://${normalized}`)
    const segments = urlObj.pathname.split('/')
    const filteredSegments = segments.filter(s => !/^[0-9a-fA-F-]{20,}$/i.test(s))
    return `${urlObj.hostname}${filteredSegments.join('/')}`.toLowerCase()
  } catch {
    return normalized.toLowerCase()
  }
}

/**
 * Returns a reliable grouping key for an addon across different accounts.
 * Primary match is manifest.id. If missing or invalid, falls back to canonical URL.
 */
export function getAddonGroupKey(addon: AddonDescriptor): string {
  const id = addon.manifest?.id
  if (id && id !== 'unknown') {
    return id.toLowerCase()
  }
  return getCanonicalAddonUrl(addon.transportUrl)
}

export function getAddonVersionKey(addon: { transportUrl: string; manifest?: { id?: string } }): string {
  return `${addon.manifest?.id || 'unknown'}::${normalizeAddonUrl(addon.transportUrl)}`
}

export function getLatestAddonVersion(
  latestVersions: Record<string, string>,
  addon: { transportUrl: string; manifest?: { id?: string; version?: string } }
): string | undefined {
  const id = addon.manifest?.id
  const instanceVersion = latestVersions[getAddonVersionKey(addon)]
  if (instanceVersion) return instanceVersion

  if (addon.manifest?.version && /[-+]/.test(addon.manifest.version)) return undefined

  const legacyLatest = id ? latestVersions[id] : undefined
  if (legacyLatest && /[-+]/.test(legacyLatest)) return undefined
  return legacyLatest
}

/**
 * Checks if a version string is strictly newer than the current version.
 * Handles 'v' prefixes, varying segment lengths, and basic semver flags.
 */
export function isNewerVersion(current?: string, latest?: string): boolean {
  if (!latest || !current) return false
  if (latest === current) return false

  const parseVersion = (v: string) => {
    const lower = v.toLowerCase().replace(/^v/, '')
    const [base, buildPart] = lower.split('+')

    const cleanBase = base.split('-')[0]
    const parts = cleanBase.split('.').map(Number)

    let buildNum = 0
    if (buildPart && buildPart.startsWith('build.')) {
      buildNum = parseInt(buildPart.split('.')[1]) || 0
    }

    return { parts, buildNum }
  }

  const c = parseVersion(current)
  const l = parseVersion(latest)

  const maxLength = Math.max(c.parts.length, l.parts.length)

  for (let i = 0; i < maxLength; i++) {
    const cPart = c.parts[i] || 0
    const lPart = l.parts[i] || 0
    if (lPart > cPart) return true
    if (lPart < cPart) return false
  }

  if (l.buildNum > c.buildNum) return true

  return false
}

const normalizeIdentityText = (value: string | undefined) => (value || '').toLowerCase().replace(NON_ALPHANUMERIC_REGEX, '')

export function hasFallbackAddonName(addon: Pick<AddonDescriptor, 'transportUrl' | 'manifest'>): boolean {
  const manifestName = addon.manifest?.name
  if (!manifestName || manifestName === 'Unknown Addon') return true

  const hostFallback = getHostnameIdentifier(addon.transportUrl)
  const normalizedName = normalizeIdentityText(manifestName)
  const normalizedHostFallback = normalizeIdentityText(hostFallback)
  return Boolean(normalizedName && normalizedName === normalizedHostFallback)
}

export function hasFallbackAddonIdentity(addon: Pick<AddonDescriptor, 'transportUrl' | 'manifest'>): boolean {
  if (hasFallbackAddonName(addon)) return true

  const hostFallback = getHostnameIdentifier(addon.transportUrl)
  const normalizedHostFallback = normalizeIdentityText(hostFallback)

  const description = addon.manifest?.description || ''
  return description.startsWith('Addon from ') && normalizeIdentityText(description).includes(normalizedHostFallback)
}

/**
 * Helper: Merge remote addons with local addons, preserving order and flags.
 * Source of Truth: Remote presence determines "enabled" status, but local flags and metadata are preserved.
 */

export function mergeAddons(localAddons: AddonDescriptor[], remoteAddons: AddonDescriptor[], options: { keepMissingLocal?: boolean; instanceMatch?: 'adopt-remote-url' | 'keep-local-url' } = {}) {
  trace('merge', 'enter', { local: localAddons.length, remote: remoteAddons.length, keepMissingLocal: !!options.keepMissingLocal })
  let merged = 0, netNew = 0, keptMissingLocal = 0, keptSpecial = 0, dropped = 0, instanceMatched = 0
  const remoteAddonMap = new Map<string, AddonDescriptor>()

  remoteAddons.forEach((a) => {
    const norm = normalizeAddonUrl(a.transportUrl)
    if (!remoteAddonMap.has(norm)) remoteAddonMap.set(norm, a)
  })

  const instanceClaims = options.instanceMatch
    ? claimInstanceRemotes(localAddons, remoteAddons)
    : new Map<AddonDescriptor, AddonDescriptor>()

  const processedRemoteNormUrls = new Set<string>()
  const finalAddons: AddonDescriptor[] = []

  const now = Date.now()
  const MANIFEST_GRACE_PERIOD = 10 * 60 * 1000 // 10 minutes

  localAddons.forEach((localAddon) => {
    const normLocal = normalizeAddonUrl(localAddon.transportUrl)

    const remoteAddon = remoteAddonMap.get(normLocal)
    const instanceRemote = remoteAddon ? undefined : instanceClaims.get(localAddon)

    const isRecentLocalChange = localAddon.metadata?.lastUpdated && (now - localAddon.metadata.lastUpdated < MANIFEST_GRACE_PERIOD)

    if (remoteAddon || instanceRemote) {
      const matchedRemote = remoteAddon || instanceRemote!
      const isSubstantial = (addon: AddonDescriptor | undefined) => {
        const m = addon?.manifest;
        if (!addon || !m || !m.name || m.name === 'Unknown Addon' || hasFallbackAddonName(addon)) return false;
        const v = (m.version || '').replace(/^v/, '');
        const hasResources = Array.isArray(m.resources) && m.resources.length > 0;
        return v !== '0.0.0' && v !== '' && hasResources;
      };

      const remoteManifest = matchedRemote.manifest;
      const localManifest = localAddon.manifest;
      const useLocalManifest = (isSubstantial(localAddon) && !isSubstantial(matchedRemote)) || isRecentLocalChange;

      let mergedMetadata = localAddon.metadata
        ? { ...localAddon.metadata }
        : (matchedRemote.metadata ? { ...matchedRemote.metadata } : undefined)

      if (!useLocalManifest && localManifest && remoteManifest) {
        const localIsFallback = hasFallbackAddonName({ transportUrl: localAddon.transportUrl, manifest: localManifest })
        if (localManifest.name && localManifest.name !== remoteManifest.name && !mergedMetadata?.customName && !localIsFallback) {
          mergedMetadata = { ...(mergedMetadata || {}), customName: localManifest.name }
        }
        if (localManifest.description && localManifest.description !== remoteManifest.description && !mergedMetadata?.customDescription) {
          mergedMetadata = { ...(mergedMetadata || {}), customDescription: localManifest.description }
        }
        if (localManifest.logo && localManifest.logo !== remoteManifest.logo && !mergedMetadata?.customLogo) {
          mergedMetadata = { ...(mergedMetadata || {}), customLogo: localManifest.logo }
        }
      }

      if (mergedMetadata?.customName) {
        const hostName = getHostnameIdentifier(localAddon.transportUrl)
        if (hostName && mergedMetadata.customName === hostName) {
          const { customName: _cn, ...rest } = mergedMetadata
          mergedMetadata = rest
        }
      }

      const finalManifest = useLocalManifest ? localManifest : remoteManifest;

      finalAddons.push({
        ...matchedRemote,
        // Instance matches carry a config-URL change: adopt the remote URL when
        // the remote is the newer state (sync fold, install, deploy), keep the
        // local one when local is authoritative (hub read).
        transportUrl: instanceRemote
          ? (options.instanceMatch === 'keep-local-url' ? localAddon.transportUrl : instanceRemote.transportUrl)
          : localAddon.transportUrl,
        manifest: finalManifest,
        flags: {
          ...matchedRemote.flags,
          protected: localAddon.flags?.protected,
          enabled: isRecentLocalChange ? (localAddon.flags?.enabled !== false) : (matchedRemote.flags?.enabled !== false),
        },
        metadata: mergedMetadata,
        catalogOverrides: localAddon.catalogOverrides,
        note: localAddon.note,
      })

      processedRemoteNormUrls.add(normalizeAddonUrl(matchedRemote.transportUrl))
      processedRemoteNormUrls.add(normLocal)
      if (instanceRemote) instanceMatched++
      else merged++
    } else {
      const hasCustomizations = localAddon.metadata?.customName || localAddon.metadata?.customLogo || localAddon.metadata?.customDescription;
      const isProtected = localAddon.flags?.protected;
      const hasNote = Boolean(localAddon.note?.trim());

      if (localAddon.flags?.enabled === false) {
        finalAddons.push({ ...localAddon })
        keptSpecial++
      } else if (isRecentLocalChange || hasCustomizations || isProtected || hasNote) {
        finalAddons.push({ ...localAddon })
        keptSpecial++
      } else if (options.keepMissingLocal) {
        finalAddons.push({ ...localAddon })
        keptMissingLocal++
      } else {
        dropped++
      }
    }
  })

  remoteAddons.forEach((remoteAddon) => {
    const normRemote = normalizeAddonUrl(remoteAddon.transportUrl)

    const alreadyProcessed = processedRemoteNormUrls.has(normRemote)

    if (!alreadyProcessed) {
      finalAddons.push({
        ...remoteAddon,
        flags: { ...(remoteAddon.flags || {}), enabled: true },
      })
      netNew++
    }
  })

  trace('merge', 'result', { local: localAddons.length, remote: remoteAddons.length, out: finalAddons.length, merged, netNew, keptMissingLocal, keptSpecial, dropped, instanceMatched })
  return finalAddons
}

export const ACCOUNT_COLORS = [
  '#3b82f6', // blue
  '#a855f7', // purple
  '#22c55e', // green
  '#f59e0b', // amber
  '#f43f5e', // rose
  '#06b2d2', // cyan
  '#f97316', // orange
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#10b981', // emerald
]

export function getTimeAgo(date: Date): string {
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000)

  let interval = seconds / 31536000
  if (interval > 1) {
    return Math.floor(interval) + 'y ago'
  }
  interval = seconds / 2592000
  if (interval > 1) {
    return Math.floor(interval) + 'mo ago'
  }
  interval = seconds / 86400
  if (interval > 1) {
    return Math.floor(interval) + 'd ago'
  }
  interval = seconds / 3600
  if (interval > 1) {
    return Math.floor(interval) + 'h ago'
  }
  interval = seconds / 60
  if (interval > 1) {
    return Math.floor(interval) + 'm ago'
  }
  if (seconds < 10) return 'just now'
  return Math.floor(seconds) + 's ago'
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function safeHref(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '#'
    return url
  } catch { return '#' }
}

export function inlineFormat(text: string, options?: { wikilinks?: boolean }): string {
  let html = escapeHtml(text)
  if (options?.wikilinks !== false) {
    html = html.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
      const safeTitle = title.replace(/"/g, '&quot;')
      return `<span class="text-primary underline underline-offset-2 decoration-primary/40 hover:decoration-primary cursor-pointer" data-wikilink="${safeTitle}">${title}</span>`
    })
  }
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>')
  html = html.replace(/`(.+?)`/g, '<code class="bg-destructive/10 text-destructive border border-destructive/15 px-1 py-0.5 rounded text-[0.8em] font-mono">$1</code>')
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, (_, t, url) => `<a href="${safeHref(url)}" class="text-primary underline underline-offset-2 hover:opacity-80" target="_blank" rel="noopener noreferrer">${t}</a>`)
  return html
}

export function formatStaleAgo(ts: number): string {
    const diff = Date.now() - ts
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
}

const IMDB_TMDB_CACHE_KEY = 'aiomanager-imdb-tmdb-cache'
const IMDB_TMDB_CACHE_TS_KEY = 'aiomanager-imdb-tmdb-cache-ts'
const IMDB_TMDB_CACHE_TTL = 7 * 24 * 60 * 60 * 1000

export function loadImdbTmdbCache(): Record<string, string> {
    try {
        const ts = Number(localStorage.getItem(IMDB_TMDB_CACHE_TS_KEY) || 0)
        if (ts && Date.now() - ts > IMDB_TMDB_CACHE_TTL) {
            localStorage.removeItem(IMDB_TMDB_CACHE_KEY)
            localStorage.removeItem(IMDB_TMDB_CACHE_TS_KEY)
            return {}
        }
        return JSON.parse(localStorage.getItem(IMDB_TMDB_CACHE_KEY) || '{}') as Record<string, string>
    } catch {
        return {}
    }
}

export function saveImdbTmdbCache(cache: Record<string, string>): void {
    try {
        localStorage.setItem(IMDB_TMDB_CACHE_KEY, JSON.stringify(cache))
        localStorage.setItem(IMDB_TMDB_CACHE_TS_KEY, String(Date.now()))
    } catch {}
}

const IMDB_TMDB_UNRESOLVED_KEY = 'aiomanager-imdb-tmdb-unresolved'
export const IMDB_UNRESOLVED_RETRY_MS = 60 * 60 * 1000
const IMDB_UNRESOLVED_TTL_MS = 24 * 60 * 60 * 1000

// Negative resolution cache: imdb ids whose TMDB find came back empty. Kept as a parallel
// map (imdbId -> timestamp) so the positive cache shape stays untouched for other consumers.
export function loadUnresolvedImdbIds(): Record<string, number> {
    try {
        const raw = JSON.parse(localStorage.getItem(IMDB_TMDB_UNRESOLVED_KEY) || '{}') as Record<string, unknown>
        const now = Date.now()
        const out: Record<string, number> = {}
        for (const [id, ts] of Object.entries(raw)) {
            const t = Number(ts)
            if (Number.isFinite(t) && now - t < IMDB_UNRESOLVED_TTL_MS) out[id] = t
        }
        return out
    } catch {
        return {}
    }
}

export function saveUnresolvedImdbIds(unresolved: Record<string, number>): void {
    try {
        localStorage.setItem(IMDB_TMDB_UNRESOLVED_KEY, JSON.stringify(unresolved))
    } catch {}
}

export function sanitizePosterUrl(url: string | undefined): string | undefined {
    if (!url || typeof url !== 'string') return url
    try {
        const parsed = new URL(url)
        const fb = parsed.searchParams.get('fallback')
        if (fb && fb.startsWith('http')) return fb
        const alt = parsed.searchParams.get('url')
        if (alt && alt.startsWith('http') && !alt.includes(parsed.hostname)) return alt
        if (parsed.hostname.includes('ratingposterdb')) return undefined
    } catch {}
    return url
}

export function formatHoursAsDays(hours: number): string {
    const whole = Math.floor(hours / 24)
    const rest = hours % 24
    if (whole === 0) return `${rest}h`
    if (rest === 0) return `${whole}d`
    return `${whole}d ${rest}h`
}

export function normalizeForSearch(s: string): string {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}
