// Public avatar catalog memo, keyed per backend baseUrl (nuvio-6). The
// catalog is static and needs no token, so one fetch per backend serves every
// connection and tab mount. Failures are not cached: the entry is never
// written, so a later mount retries. Cleared on vault lock and logout with
// the rest of the display read cache.
import { cachedRead } from './display-read-cache.ts'
import type { NuvioAvatar } from './nuvio-avatars.ts'

const AVATAR_TTL_MS = 4 * 60 * 60 * 1000

// Trailing-slash and empty normalization only: two backends never share a key.
export function avatarCatalogBackendKey(baseUrl: string | null | undefined): string {
    return String(baseUrl || '').trim().replace(/\/+$/, '')
}

export function readAvatarCatalogCached(baseUrl: string | null | undefined, load: () => Promise<NuvioAvatar[]>): Promise<NuvioAvatar[]> {
    return cachedRead(`nuvio:avatars:${avatarCatalogBackendKey(baseUrl)}`, load, { ttlMs: AVATAR_TTL_MS })
}
