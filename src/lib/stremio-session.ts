export const STREMIO_EXPIRED_KEY_MESSAGE = 'Invalid or expired auth key'

// Stremio answers a logged-out or unknown key with HTTP 200 and error code 1; stremio-core logs out on exactly this code.
export function isStremioSessionGone(apiError: unknown): boolean {
    return typeof apiError === 'object' && apiError !== null && (apiError as { code?: unknown }).code === 1
}

export function stremioSessionGoneError(): Error & { isAuthError: true } {
    return Object.assign(new Error(STREMIO_EXPIRED_KEY_MESSAGE), { isAuthError: true as const })
}
