import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return email
  const [local, domain] = email.split('@')
  if (local.length <= 3) return `***@${domain}`
  return `${local.substring(0, 3)}***@${domain}`
}

export function maskString(str: string): string {
  if (!str) return ''
  if (str.length <= 8) return '********'
  return `${str.substring(0, 4)}****${str.substring(str.length - 4)}`
}

export function maskUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    const hostname = urlObj.hostname
    return `${urlObj.protocol}//${hostname}/********`
  } catch {
    return '********'
  }
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
    // On mobile, just use the deep link, browsers handle it better with a prompt
    window.location.href = deepLink
    // Fallback if they don't have it? We can't easily detect.
    // But we can offer a button in the UI if we want to be fancy.
    return
  }

  // Desktop/Web logic
  const start = Date.now()
  let blurred = false

  const onBlur = () => { blurred = true }
  window.addEventListener('blur', onBlur)

  // Try deep link
  window.location.href = deepLink

  setTimeout(() => {
    window.removeEventListener('blur', onBlur)
    if (!blurred && (Date.now() - start < 1000)) {
      // If we didn't blur and it's been ~500ms, the protocol probably isn't handled.
      // We open the web version as a fallback.
      window.open(webLink, '_blank')
    }
  }, 500)
}

export function getAddonConfigureUrl(installUrl: string): string {
  return installUrl.replace('manifest.json', 'configure')
}

/**
 * Normalizes an addon URL for consistent comparison.
 * Handles stremio:// protocols, trailing slashes, and manifest.json suffixes.
 * Note: Case is NOT forced here to preserve Base64 tokens; callers should .toLowerCase() if needed.
 */
export function normalizeAddonUrl(url: string): string {
  if (!url) return ''
  let normalized = url.trim()
  normalized = normalized.replace(/^stremio:\/\//i, 'https://')
  normalized = normalized.replace(/\/manifest\.json$/i, '')
  normalized = normalized.replace(/\/+$/, '')
  return normalized
}

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

/**
 * Checks if a version string is strictly newer than the current version.
 * Handles 'v' prefixes, varying segment lengths, and basic semver flags.
 */
export function isNewerVersion(current?: string, latest?: string): boolean {
  if (!latest || !current) return false
  if (latest === current) return false

  const clean = (v: string) => v.toLowerCase().replace(/^v/, '').split('-')[0]
  const cParts = clean(current).split('.').map(Number)
  const lParts = clean(latest).split('.').map(Number)

  const maxLength = Math.max(cParts.length, lParts.length)

  for (let i = 0; i < maxLength; i++) {
    const c = cParts[i] || 0
    const l = lParts[i] || 0
    if (l > c) return true
    if (l < c) return false
  }

  return false
}

/**
 * Helper: Merge remote addons with local addons, preserving order and flags.
 * Source of Truth: Remote presence determines "enabled" status, but local flags and metadata are preserved.
 */
import { AddonDescriptor } from '@/types/addon'

export function mergeAddons(localAddons: AddonDescriptor[], remoteAddons: AddonDescriptor[]) {
  // 1. Map remote addons for lookup (by normalized URL)
  // STRICT: Case-sensitive URL matching only. No ID-based deduplication.
  const remoteAddonMap = new Map<string, AddonDescriptor>()

  remoteAddons.forEach((a) => {
    const norm = normalizeAddonUrl(a.transportUrl)
    if (!remoteAddonMap.has(norm)) remoteAddonMap.set(norm, a)
  })

  const processedRemoteNormUrls = new Set<string>()
  const finalAddons: AddonDescriptor[] = []

  const now = Date.now()
  const MANIFEST_GRACE_PERIOD = 10 * 60 * 1000 // 10 minutes

  // 2. Iterate through LOCAL addons to preserve their order
  localAddons.forEach((localAddon) => {
    const normLocal = normalizeAddonUrl(localAddon.transportUrl)

    // STRICT: Only match by transportUrl to support multiple instances of same manifest ID (e.g. AIOStreams variants)
    const remoteAddon = remoteAddonMap.get(normLocal)

    const isRecentLocalChange = localAddon.metadata?.lastUpdated && (now - localAddon.metadata.lastUpdated < MANIFEST_GRACE_PERIOD)

    if (remoteAddon) {
      // ANTI-WIPE GUARD: Favor local manifest if remote is 'broken' or if we recently updated/enabled it locally.
      const isSubstantial = (m: any) => {
        if (!m || !m.name || m.name === 'Unknown Addon') return false;
        const v = (m.version || '').replace(/^v/, '');
        const hasResources = Array.isArray(m.resources) && m.resources.length > 0;
        return v !== '0.0.0' && v !== '' && hasResources;
      };

      const remoteManifest = remoteAddon.manifest;
      const localManifest = localAddon.manifest;
      const useLocalManifest = (isSubstantial(localManifest) && !isSubstantial(remoteManifest)) || isRecentLocalChange;

      // Metadata: start from local (which carries customName, customLogo, etc.)
      let mergedMetadata = localAddon.metadata
        ? { ...localAddon.metadata }
        : (remoteAddon.metadata ? { ...remoteAddon.metadata } : undefined)

      // MIGRATION: If we chose the remote manifest over local, check whether the
      // local manifest had a different name/description/logo. If so, the local value
      // was a user customization that was baked into the manifest but never migrated
      // to the metadata fields. Migrate it now so it survives all future merges.
      // Guard: only migrate if metadata doesn't already have an explicit override.
      if (!useLocalManifest && localManifest && remoteManifest) {
        if (localManifest.name && localManifest.name !== remoteManifest.name && !mergedMetadata?.customName) {
          mergedMetadata = { ...(mergedMetadata || {}), customName: localManifest.name }
        }
        if (localManifest.description && localManifest.description !== remoteManifest.description && !mergedMetadata?.customDescription) {
          mergedMetadata = { ...(mergedMetadata || {}), customDescription: localManifest.description }
        }
        if (localManifest.logo && localManifest.logo !== remoteManifest.logo && !mergedMetadata?.customLogo) {
          mergedMetadata = { ...(mergedMetadata || {}), customLogo: localManifest.logo }
        }
      }

      // NAME COLLISION GUARD: If the remote name looks like a hostname/URL, and we have a local customized name,
      // favor the local name more aggressively to avoid showing "https://..." in the UI.
      const isHostname = (s: string) => /^[a-z0-9-]+\.[a-z0-9-]{2,}/i.test(s) || s.startsWith('http');
      if (remoteManifest.name && isHostname(remoteManifest.name) && mergedMetadata?.customName) {
        // Local customName is already in mergedMetadata from the logic above or existing state
      }

      let finalManifest = useLocalManifest ? localManifest : remoteManifest;

      finalAddons.push({
        ...remoteAddon,
        transportUrl: localAddon.transportUrl,
        manifest: finalManifest,
        flags: {
          ...remoteAddon.flags,
          protected: localAddon.flags?.protected,
          enabled: isRecentLocalChange ? (localAddon.flags?.enabled !== false) : true,
        },
        metadata: mergedMetadata,
        catalogOverrides: localAddon.catalogOverrides,
      })

      processedRemoteNormUrls.add(normalizeAddonUrl(remoteAddon.transportUrl))
      processedRemoteNormUrls.add(normLocal)
    } else if (isRecentLocalChange) {
      // Missing from remote but was RECENTLY changed locally (e.g. just installed or enabled)
      // We keep it so it can be pushed to remote in the next sync cycle.
      finalAddons.push({
        ...localAddon,
        flags: {
          ...(localAddon.flags || {}),
          enabled: localAddon.flags?.enabled !== false
        },
      })
    }
    // If not in remote AND not recently changed -> DROP (1:1 Mirroring)
  })

  // 3. Append any NEW remote addons that weren't accounted for
  remoteAddons.forEach((remoteAddon) => {
    const normRemote = normalizeAddonUrl(remoteAddon.transportUrl)

    // STRICT: Only skip if this exact URL has been processed
    const alreadyProcessed = processedRemoteNormUrls.has(normRemote)

    if (!alreadyProcessed) {
      finalAddons.push({
        ...remoteAddon,
        flags: { ...(remoteAddon.flags || {}), enabled: true },
      })
    }
  })

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
  return Math.floor(seconds) + 's ago'
}
