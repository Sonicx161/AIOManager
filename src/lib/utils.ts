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
  const remoteAddonMap = new Map()
  remoteAddons.forEach((a) => {
    const norm = normalizeAddonUrl(a.transportUrl).toLowerCase()
    if (!remoteAddonMap.has(norm)) remoteAddonMap.set(norm, a)
  })

  const processedRemoteNormUrls = new Set<string>()
  const finalAddons: AddonDescriptor[] = []

  // 2. Iterate through LOCAL addons to preserve their order
  localAddons.forEach((localAddon) => {
    const normLocal = normalizeAddonUrl(localAddon.transportUrl).toLowerCase()
    const remoteAddon = remoteAddonMap.get(normLocal)

    if (remoteAddon) {
      // Exists in both: Use Remote data + Local flags
      // CRITICAL: If it exists in remote, it IS currently active/enabled in Stremio.
      finalAddons.push({
        ...remoteAddon,
        flags: {
          ...remoteAddon.flags,
          protected: localAddon.flags?.protected,
          enabled: true, // Trust remote presence
        },
        metadata: localAddon.metadata,
      })
      processedRemoteNormUrls.add(normLocal)
    } else {
      // Catch-all preservation: Keep ALL local addons even if missing from remote.
      // If missing from remote, mark as disabled locally so we don't wipe their metadata/names.
      // This prevents the '???' issue in Failover/Addon list.
      finalAddons.push({
        ...localAddon,
        flags: { ...(localAddon.flags || {}), enabled: false },
      })
    }
  })

  // 3. Append any NEW remote addons that weren't in local list
  remoteAddons.forEach((remoteAddon) => {
    const normRemote = normalizeAddonUrl(remoteAddon.transportUrl).toLowerCase()
    if (!processedRemoteNormUrls.has(normRemote)) {
      finalAddons.push({
        ...remoteAddon,
        flags: { ...(remoteAddon.flags || {}), enabled: true },
      })
    }
  })

  return finalAddons
}
