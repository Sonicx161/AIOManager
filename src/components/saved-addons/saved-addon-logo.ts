// Pure logo resolution for saved addons. Relative .ts imports keep it runnable under node:test.
import { buildAddonLogoIndex, resolveAddonLogo, type AddonLogoIndex } from '../addons/addon-card-helpers.ts'

export interface SavedAddonLogoTarget {
    installUrl: string
    manifest: { id?: string; name?: string; logo?: string }
    metadata?: { customLogo?: string }
}

interface LogoSourceAddon {
    transportUrl?: string
    installUrl?: string
    manifest?: { id?: string; name?: string; logo?: string } | null
}

let indexCache: { accounts: unknown; library: unknown; index: AddonLogoIndex } | null = null

export function getSavedAddonLogoIndex(
    accounts: ReadonlyArray<{ addons?: LogoSourceAddon[] }>,
    library: Record<string, LogoSourceAddon>,
): AddonLogoIndex {
    if (indexCache && indexCache.accounts === accounts && indexCache.library === library) return indexCache.index
    const sources = [...accounts.flatMap(account => account.addons || []), ...Object.values(library)]
    indexCache = { accounts, library, index: buildAddonLogoIndex(sources) }
    return indexCache.index
}

// Custom logo, then manifest logo, then the same addon on another account or in the library, then the known-logo list.
export function resolveSavedAddonLogo(addon: SavedAddonLogoTarget, index?: AddonLogoIndex | null): string | undefined {
    return resolveAddonLogo({ transportUrl: addon.installUrl, manifest: addon.manifest, metadata: addon.metadata }, index)
}
