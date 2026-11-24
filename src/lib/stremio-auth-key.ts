export const NO_STREMIO_KEY_MESSAGE = 'No auth key stored for this connection'

// An empty key reads Stremio's default addon list and a zeroed user as a success; never send one.
export function hasStremioAuthKey(authKey: unknown): authKey is string {
    return typeof authKey === 'string' && authKey.trim() !== ''
}
