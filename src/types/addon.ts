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
  resources?: unknown[]
  idPrefixes?: string[]
  behaviorHints?: {
    adult?: boolean
    p2p?: boolean
    configurable?: boolean
    configurationRequired?: boolean
  }
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
  metadata?: {
    customName?: string
    customLogo?: string
    customDescription?: string
    lastUpdated?: number
    cinemetaConfig?: import('./cinemeta').CinemetaConfigState
  }
  catalogOverrides?: {
    removed: string[]
  }
  syncToLibrary?: boolean
}
