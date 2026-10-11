// Preserve opaque config paths and query strings; comparison keys are not transport URLs.
export function addonEndpointUrl(input: string, endpoint: 'manifest.json' | 'configure'): string {
    const value = input.trim().replace(/^stremio:\/\//i, 'https://')
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported addon URL protocol')
    const suffixAt = value.search(/[?#]/)
    const base = suffixAt < 0 ? value : value.slice(0, suffixAt)
    const suffix = suffixAt < 0 ? '' : value.slice(suffixAt)
    const path = base.replace(/\/+$/, '').replace(/\/(manifest(?:\.json)?|configure)$/i, '')
    return `${path}/${endpoint}${suffix}`
}

export function addonManifestUrl(input: string): string {
    // Leave invalid input to the existing manifest/collection validation boundary.
    try { return addonEndpointUrl(input, 'manifest.json') } catch { return input }
}
