import { AddonDescriptor, AddonManifest } from '@/types/addon'
import { isCinemetaAddon, detectAllPatches, applyCinemetaConfiguration } from '@/lib/cinemeta-utils'

/**
 * Returns a manifest for the addon with active overrides applied.
 * Currently supports filtering out removed catalogs and applying custom metadata.
 */
export function getEffectiveManifest(addon: {
    manifest?: AddonManifest;
    metadata?: { customName?: string; customLogo?: string; customDescription?: string };
    catalogOverrides?: { removed: string[] };
}): AddonManifest {
    const baseManifest = addon.manifest || {
        id: 'unknown',
        name: 'Unknown Addon',
        version: '0.0.0',
        description: '',
        resources: [],
        types: []
    }
    const manifest = {
        ...baseManifest,
        types: baseManifest.types || [],
        resources: baseManifest.resources || []
    } as AddonManifest

    // 1. Apply Metadata Overrides (Name, Logo, Description)
    if (addon.metadata?.customName) manifest.name = addon.metadata.customName
    if (addon.metadata?.customLogo) manifest.logo = addon.metadata.customLogo
    if (addon.metadata?.customDescription) manifest.description = addon.metadata.customDescription

    // 2. Apply Catalog Overrides (Removed Catalogs)
    if (addon.catalogOverrides?.removed && manifest.catalogs) {
        const removedIds = new Set(addon.catalogOverrides.removed)
        manifest.catalogs = manifest.catalogs.filter(cat => !removedIds.has(cat.id))
    }

    // 3. CINEMETA REPAIR: If this is Cinemeta, re-apply any detected patches to the manifest.
    // This is the fallback that ensures "Patched" UI status matches actual manifest behavior
    // even if the raw manifest was just pulled from Stremio.
    if (isCinemetaAddon({ ...addon, manifest } as any)) {
        const patches = detectAllPatches(manifest as any);
        if (patches.searchArtifactsPatched || patches.standardCatalogsPatched || patches.metaResourcePatched) {
            return applyCinemetaConfiguration(manifest as any, {
                removeSearchArtifacts: patches.searchArtifactsPatched,
                removeStandardCatalogs: patches.standardCatalogsPatched,
                removeMetaResource: patches.metaResourcePatched
            }) as any;
        }
    }

    return manifest
}

/**
 * Transforms an addon descriptor into the format expected by Stremio, 
 * applying all local customizations.
 */
export function transformAddonForStremio(addon: AddonDescriptor): AddonDescriptor {
    if (!addon) return addon
    return {
        ...addon,
        manifest: getEffectiveManifest(addon)
    }
}

/**
 * Prepares a list of addons for syncing to Stremio.
 * Filters out disabled addons and applies customizations.
 */
export function prepareAddonsForSync(addons: AddonDescriptor[]): AddonDescriptor[] {
    return (addons || [])
        .filter(addon => addon.flags?.enabled !== false)
        .map(transformAddonForStremio)
}
