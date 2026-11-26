import type { AddonDescriptor } from '@/types/addon'
import { stripDestinationsForWire } from '@/lib/addon-destinations'

// Nuvio only takes the name, so only the custom name is applied; catalog overrides never reach this write.
export function nuvioWireAddons(addons: AddonDescriptor[]): AddonDescriptor[] {
    return stripDestinationsForWire(addons).map(addon => {
        const customName = addon.metadata?.customName
        return addon.manifest && typeof customName === 'string' && customName ? { ...addon, manifest: { ...addon.manifest, name: customName } } : addon
    })
}
