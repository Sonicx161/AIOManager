import { AddonManifest } from './addon'

// Cinemeta-specific catalog structure
export interface CinemetaCatalogExtra {
  name: string
  isRequired?: boolean
  options?: string[]
  optionsLimit?: number
}

export interface CinemetaCatalog {
  type: string
  id: string
  name?: string
  extra?: CinemetaCatalogExtra[]
}

// Extended manifest with typed catalogs
export interface CinemetaManifest extends AddonManifest {
  catalogs: CinemetaCatalog[]
  resources: string[]
}

// Configuration state for toggles
export interface CinemetaConfigState {
  removeSearchArtifacts: boolean
  removeStandardCatalogs: boolean
  removeMetaResource: boolean
}

// Detection results
export interface CinemetaPatchStatus {
  searchArtifactsPatched: boolean
  standardCatalogsPatched: boolean
  metaResourcePatched: boolean
}
