/** Display label for a vault key: provider and host only, never a trailing id or a URL path. */
export function vaultKeyLabel(key: { name?: string; customProviderName?: string; provider: string }): string {
    const name = key.name || key.customProviderName || key.provider
    const segments = name.split(' · ').slice(0, 2).map(segment => {
        try {
            return /^https?:\/\//i.test(segment) ? new URL(segment).host : segment
        } catch {
            return segment
        }
    })
    return segments.join(' · ')
}

export function vaultKeySearchHost(serverUrl?: string): string {
    if (!serverUrl) return ''
    try {
        return new URL(serverUrl).host
    } catch {
        return ''
    }
}
