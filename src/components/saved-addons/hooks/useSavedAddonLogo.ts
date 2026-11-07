import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { getSavedAddonLogoIndex, resolveSavedAddonLogo, type SavedAddonLogoTarget } from '../saved-addon-logo'

export function useSavedAddonLogo(addon?: SavedAddonLogoTarget | null): string | undefined {
    const own = addon ? addon.metadata?.customLogo || addon.manifest?.logo : undefined
    const library = useAddonStore((state) => (addon && !own ? state.library : null))
    const fallback = useAccountStore((state) => (addon && !own && library ? resolveSavedAddonLogo(addon, getSavedAddonLogoIndex(state.accounts, library)) : undefined))
    return own || fallback
}
