export function parseAIOStreamsUrl(transportUrl: string): { baseUrl: string; uuid: string } | null {
    try {
        // AIOStreams alias URLs nest the user under /stremio/u/<alias>/ - skip the
        // alias marker so the captured segment is the actual user identifier.
        const match = transportUrl.match(/^(https?:\/\/.+?)\/stremio\/(?:u\/)?([^/]+)\//i)
        if (!match) return null
        return { baseUrl: match[1], uuid: decodeURIComponent(match[2]) }
    } catch {
        return null
    }
}

export function getAIOStreamsConfigureUrl(transportUrl: string): string | null {
    try {
        return transportUrl.replace(/\/manifest(\.json)?$/i, '/configure').replace(/([^:]\/)\/+/g, '$1')
    } catch {
        return null
    }
}
