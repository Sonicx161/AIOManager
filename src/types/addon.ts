export interface Catalog {
  id: string
  type: string
  name?: string
  extra?: Array<{
    name: string
    isRequired?: boolean
    options?: string[]
  }>
}

export interface AddonManifest {
  id: string
  name: string
  version: string
  description: string
  logo?: string
  background?: string
  types?: string[]
  catalogs?: Catalog[]
  resources?: Array<string | { name: string; types?: string[]; idPrefixes?: string[] }>
  idPrefixes?: string[]
  behaviorHints?: {
    adult?: boolean
    p2p?: boolean
    configurable?: boolean
    configurationRequired?: boolean
  }
}

// Per-addon destination policy (deny-list) — see AddonDescriptor.destinations.
export interface AddonDestinations {
  excludedPlatforms?: string[]
  excludedConnections?: string[]
  // LWW clock for cross-device convergence (see lib/addon-destinations.ts). Assigned on
  // every deliberate policy WRITE from the picker (set or clear) via nextPolicyRevision,
  // so it never regresses even under clock skew; imports/merges never bump it. A policy
  // cleared of every exclusion survives as the tombstone { revision } so the clear
  // itself can propagate — behaviorally identical to an absent policy. Absent on rows
  // written by pre-revision clients (treated as 0).
  revision?: number
}

export interface AddonDescriptor {
  transportUrl: string
  transportName?: string
  manifest: AddonManifest
  flags?: {
    official?: boolean
    protected?: boolean
    enabled?: boolean
  }
  // Per-addon destination policy (deny-list). Absent = sync everywhere. Platform
  // entries cover every login of that platform, present and future; connection ids
  // are exact stable login ids. Never removed from the hub: exclusion means the
  // target's next sync removes its copy, nothing more. Pure helpers live in
  // src/lib/addon-destinations.ts; the server twin is server/utils/addon-destinations.js.
  destinations?: AddonDestinations
  metadata?: {
    customName?: string
    customLogo?: string
    customDescription?: string
    lastUpdated?: number
    cinemetaConfig?: import('./cinemeta').CinemetaConfigState
    hideConfigure?: boolean
    // Pre-customization name/logo/description, captured locally so Reset works offline.
    originalManifest?: { name?: string; logo?: string; description?: string }
  }
  catalogOverrides?: CatalogOverrides
  syncToLibrary?: boolean
  note?: string
}

export interface CatalogOverrides {
  removed: string[]
  catalogs?: Catalog[]
}
