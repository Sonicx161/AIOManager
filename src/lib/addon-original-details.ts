import type { AddonManifest } from '@/types/addon'

export type OriginalDetails = { name?: string; logo?: string; description?: string }
type DetailKey = keyof OriginalDetails
type CustomKey = 'customName' | 'customLogo' | 'customDescription'

export const DETAIL_FIELD_MAP: Record<CustomKey, DetailKey> = {
    customName: 'name',
    customLogo: 'logo',
    customDescription: 'description',
}

const isCustomKey = (field: string): field is CustomKey => field in DETAIL_FIELD_MAP

// Records the manifest value a customization is about to cover, so Reset can restore it
// without the addon host. Only fields still showing their original value are captured.
export function captureOriginalDetails(
    manifest: Partial<AddonManifest>,
    metadata: Partial<Record<CustomKey, string>> | undefined,
    stored: OriginalDetails | undefined,
    settingsMetadata: Record<string, unknown>,
): OriginalDetails {
    const next: OriginalDetails = { ...(stored || {}) }
    for (const field of Object.keys(DETAIL_FIELD_MAP) as CustomKey[]) {
        const key = DETAIL_FIELD_MAP[field]
        if (settingsMetadata[field] !== undefined && !metadata?.[field] && next[key] === undefined) {
            next[key] = (manifest[key] as string | undefined) || ''
        }
    }
    return next
}

// Only fields that were actually customized need restoring. Those with no stored original
// are the ones that require a remote manifest.
export function planDetailReset(
    clearedFields: string[],
    metadata: Partial<Record<CustomKey, string>> | undefined,
    stored: OriginalDetails | undefined,
): { resetFields: CustomKey[]; needsRemote: boolean } {
    const resetFields = clearedFields.filter(isCustomKey).filter(field => Boolean(metadata?.[field]))
    const needsRemote = resetFields.some(field => stored?.[DETAIL_FIELD_MAP[field]] === undefined)
    return { resetFields, needsRemote }
}

export function applyDetailReset(
    manifest: AddonManifest,
    resetFields: CustomKey[],
    stored: OriginalDetails | undefined,
    remote?: Partial<AddonManifest> | null,
): { manifest: AddonManifest; stored: OriginalDetails } {
    const next = { ...manifest } as unknown as Record<string, unknown>
    const remaining: OriginalDetails = { ...(stored || {}) }
    for (const field of resetFields) {
        const key = DETAIL_FIELD_MAP[field]
        const original = stored?.[key] ?? (remote?.[key] as string | undefined)
        if (original) next[key] = original
        else if (key !== 'name') delete next[key]
        delete remaining[key]
    }
    return { manifest: next as unknown as AddonManifest, stored: remaining }
}
