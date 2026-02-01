import { AddonDescriptor } from '@/types/addon'

/**
 * Transforms an addon descriptor into the format expected by Stremio, 
 * applying all local customizations (custom name, logo, description).
 */
export function transformAddonForStremio(addon: AddonDescriptor): AddonDescriptor {
    if (!addon) return addon

    // If there's custom metadata, override the manifest fields
    if (addon.metadata?.customName || addon.metadata?.customDescription || addon.metadata?.customLogo) {
        return {
            ...addon,
            manifest: {
                ...addon.manifest,
                name: addon.metadata.customName || addon.manifest?.name || '',
                logo: addon.metadata.customLogo || addon.manifest?.logo || undefined,
                description: addon.metadata.customDescription || addon.manifest?.description || ''
            }
        }
    }

    return addon
}

/**
 * Prepares a list of addons for syncing to Stremio.
 * Filters out disabled addons and applies customizations.
 */
export function prepareAddonsForSync(addons: AddonDescriptor[]): AddonDescriptor[] {
    return addons
        .filter(addon => addon.flags?.enabled !== false)
        .map(transformAddonForStremio)
}
