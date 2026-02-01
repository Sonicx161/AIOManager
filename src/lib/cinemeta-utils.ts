import { CinemetaManifest, CinemetaConfigState, CinemetaPatchStatus } from '@/types/cinemeta'
import { AddonDescriptor } from '@/types/addon'
import { stremioClient } from '@/api/stremio-client'

// ============================================================================
// Detection Functions (read-only)
// ============================================================================

/**
 * Detects if search artifacts have been removed from the manifest
 * Returns true if the search catalogs and extras are missing (patch applied)
 */
export function detectSearchArtifactsPatched(manifest: CinemetaManifest): boolean {
  const catalogs = manifest.catalogs || []

  // Check if search catalogs are missing
  const hasSearchMovie = catalogs.some((c) => c.id === 'cinemeta.search' && c.type === 'movie')
  const hasSearchSeries = catalogs.some((c) => c.id === 'cinemeta.search' && c.type === 'series')

  // Check if 'search' extra is missing from top catalogs
  const topMovie = catalogs.find((c) => c.id === 'top' && c.type === 'movie')
  const topSeries = catalogs.find((c) => c.id === 'top' && c.type === 'series')

  const topMovieHasSearchExtra =
    topMovie && Array.isArray(topMovie.extra) && topMovie.extra.some((e) => e.name === 'search')
  const topSeriesHasSearchExtra =
    topSeries && Array.isArray(topSeries.extra) && topSeries.extra.some((e) => e.name === 'search')

  // Patch is applied if search catalogs are missing AND search extras are missing from top catalogs
  return !hasSearchMovie && !hasSearchSeries && !topMovieHasSearchExtra && !topSeriesHasSearchExtra
}

/**
 * Detects if standard catalogs have been removed or modified
 * Returns true if:
 * - All standard catalogs are missing (both toggles ON), OR
 * - Popular catalogs are modified (search extra has isRequired: true) and New/Featured are removed
 *   (only 'Remove Cinemeta Catalogs' ON but 'Remove Cinemeta Search' OFF)
 */
export function detectStandardCatalogsPatched(manifest: CinemetaManifest): boolean {
  const catalogs = manifest.catalogs || []

  // Check if standard catalogs exist
  const hasPopularMovie = catalogs.some((c) => c.id === 'top' && c.type === 'movie')
  const hasPopularSeries = catalogs.some((c) => c.id === 'top' && c.type === 'series')
  const hasNewMovie = catalogs.some((c) => c.id === 'year' && c.type === 'movie')
  const hasNewSeries = catalogs.some((c) => c.id === 'year' && c.type === 'series')
  const hasFeaturedMovie = catalogs.some((c) => c.id === 'imdbRating' && c.type === 'movie')
  const hasFeaturedSeries = catalogs.some((c) => c.id === 'imdbRating' && c.type === 'series')

  // Check if Popular catalogs have been modified (search extra has isRequired: true)
  const popularMovieCatalog = catalogs.find((c) => c.id === 'top' && c.type === 'movie')
  const popularSeriesCatalog = catalogs.find((c) => c.id === 'top' && c.type === 'series')

  const isPopularMovieModified = Boolean(
    popularMovieCatalog &&
    Array.isArray(popularMovieCatalog.extra) &&
    popularMovieCatalog.extra.some((e) => e.name === 'search' && e.isRequired === true)
  )
  const isPopularSeriesModified = Boolean(
    popularSeriesCatalog &&
    Array.isArray(popularSeriesCatalog.extra) &&
    popularSeriesCatalog.extra.some((e) => e.name === 'search' && e.isRequired === true)
  )

  // Scenario 1: All standard catalogs are removed (both toggles ON)
  const allCatalogsRemoved =
    !hasPopularMovie &&
    !hasPopularSeries &&
    !hasNewMovie &&
    !hasNewSeries &&
    !hasFeaturedMovie &&
    !hasFeaturedSeries

  // Scenario 2: Popular catalogs are modified and New/Featured are removed (only 'Remove Cinemeta Catalogs' ON)
  const popularModifiedAndOthersRemoved =
    hasPopularMovie &&
    hasPopularSeries &&
    isPopularMovieModified &&
    isPopularSeriesModified &&
    !hasNewMovie &&
    !hasNewSeries &&
    !hasFeaturedMovie &&
    !hasFeaturedSeries

  // Patch is applied if either scenario is true
  return allCatalogsRemoved || popularModifiedAndOthersRemoved
}

/**
 * Detects if meta resource has been removed
 * Returns true if 'meta' is missing from resources (patch applied)
 */
export function detectMetaResourcePatched(manifest: CinemetaManifest): boolean {
  const resources = Array.isArray(manifest.resources) ? manifest.resources : []

  // Patch is applied if 'meta' is not in resources
  return !resources.includes('meta')
}

// ============================================================================
// Transformation Functions (return new manifest)
// ============================================================================

/**
 * Removes search artifacts from Cinemeta manifest
 */
export function removeCinemetaSearchArtifacts(manifest: CinemetaManifest): CinemetaManifest {
  const modifiedCatalogs = manifest.catalogs
    // Filter out catalogs with id === 'cinemeta.search'
    .filter((catalog) => catalog.id !== 'cinemeta.search')
    // Remove search extras from remaining catalogs
    .map((catalog) => ({
      ...catalog,
      extra: catalog.extra?.filter((extra) => extra.name !== 'search'),
    }))

  return {
    ...manifest,
    catalogs: modifiedCatalogs,
  }
}

/**
 * Removes or modifies standard catalogs (Popular, New, Featured)
 * @param keepSearchExtras - If true, modifies Popular catalogs to keep search working
 */
export function removeCinemetaStandardCatalogs(
  manifest: CinemetaManifest,
  keepSearchExtras: boolean
): CinemetaManifest {
  const standardCatalogIds = ['top', 'year', 'imdbRating']

  if (keepSearchExtras) {
    // Modify Popular catalogs to add isRequired: true to search extra
    const modifiedCatalogs = manifest.catalogs.map((catalog) => {
      if (catalog.id.includes('top')) {
        return {
          ...catalog,
          extra: catalog.extra?.map((extra) =>
            extra.name === 'search' ? { ...extra, isRequired: true } : extra
          ),
        }
      }
      return catalog
    })

    // Filter out year and imdbRating catalogs
    return {
      ...manifest,
      catalogs: modifiedCatalogs.filter(
        (catalog) => !catalog.id.includes('year') && !catalog.id.includes('imdbRating')
      ),
    }
  }

  // Remove all standard catalogs completely
  return {
    ...manifest,
    catalogs: manifest.catalogs.filter(
      (catalog) => !standardCatalogIds.some((id) => catalog.id.includes(id))
    ),
  }
}

/**
 * Removes meta resource from manifest
 */
export function removeMeta(manifest: CinemetaManifest): CinemetaManifest {
  return {
    ...manifest,
    resources: manifest.resources.filter((resource) => resource !== 'meta'),
  }
}

/**
 * Applies all Cinemeta configuration transformations
 */
export function applyCinemetaConfiguration(
  manifest: CinemetaManifest,
  config: CinemetaConfigState
): CinemetaManifest {
  let modifiedManifest = { ...manifest }

  // Apply search artifacts removal
  if (config.removeSearchArtifacts) {
    modifiedManifest = removeCinemetaSearchArtifacts(modifiedManifest)
  }

  // Apply standard catalogs removal (conditional logic)
  if (config.removeSearchArtifacts && config.removeStandardCatalogs) {
    // If BOTH flags are ON: remove all catalogs completely
    modifiedManifest = removeCinemetaStandardCatalogs(modifiedManifest, false)
  } else if (config.removeStandardCatalogs) {
    // If ONLY catalog flag ON: modify Popular (keep search working)
    modifiedManifest = removeCinemetaStandardCatalogs(modifiedManifest, true)
  }

  // Apply meta resource removal
  if (config.removeMetaResource) {
    modifiedManifest = removeMeta(modifiedManifest)
  }

  return modifiedManifest
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Fetches the original Cinemeta manifest from the transport URL
 */
export async function fetchOriginalCinemetaManifest(
  transportUrl: string
): Promise<CinemetaManifest> {
  const descriptor = await stremioClient.fetchAddonManifest(transportUrl)
  return descriptor.manifest as CinemetaManifest
}

/**
 * Detects if an addon is Cinemeta
 */
export function isCinemetaAddon(addon: AddonDescriptor): boolean {
  const CINEMETA_IDS = ['com.linvo.cinemeta', 'org.stremio.cinemeta', 'cinemeta']
  return (
    CINEMETA_IDS.includes(addon.manifest.id) ||
    addon.manifest.name.toLowerCase().includes('cinemeta') ||
    (addon.flags?.official === true && addon.manifest.name === 'Cinemeta')
  )
}

/**
 * Detects all patches applied to a Cinemeta manifest
 */
export function detectAllPatches(manifest: CinemetaManifest): CinemetaPatchStatus {
  return {
    searchArtifactsPatched: detectSearchArtifactsPatched(manifest),
    standardCatalogsPatched: detectStandardCatalogsPatched(manifest),
    metaResourcePatched: detectMetaResourcePatched(manifest),
  }
}
