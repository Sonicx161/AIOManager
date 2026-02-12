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
    let remoteAddon = remoteAddonMap.get(normLocal)

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

      finalAddons.push({
        ...remoteAddon,
        transportUrl: localAddon.transportUrl, // PRESERVE LOCAL URL (The user's new one)
        manifest: useLocalManifest ? localManifest : remoteManifest,
        flags: {
          ...remoteAddon.flags,
          protected: localAddon.flags?.protected,
          enabled: isRecentLocalChange ? (localAddon.flags?.enabled !== false) : true, // Trust remote presence UNLESS we just changed it locally
        },
        metadata: localAddon.metadata,
        catalogOverrides: localAddon.catalogOverrides,
      })

      processedRemoteNormUrls.add(normalizeAddonUrl(remoteAddon.transportUrl))
      processedRemoteNormUrls.add(normLocal)
    } else {
      // Missing from remote: mark as disabled locally UNLESS it was recently changed (e.g. just enabled)
      finalAddons.push({
        ...localAddon,
        flags: {
          ...(localAddon.flags || {}),
          enabled: isRecentLocalChange ? (localAddon.flags?.enabled !== false) : false
        },
      })
    }
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
