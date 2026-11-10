export const STREMIO_PASSWORD_RESET_COPY = {
    title: 'Stremio needs a new password',
    body: 'Stremio has asked for a new password on this account. Set one on Stremio, then sign in here again.',
    actionLabel: 'Reset on Stremio',
    retryLabel: 'Try again',
} as const

// Stremio sends code 28 with the reset-required message; login() attaches it to err.code as a string.
const RESET_ERROR_CODE = '28'

export function isStremioPasswordResetError(err: unknown): boolean {
    const code = (err as { code?: unknown } | null | undefined)?.code
    if (code === RESET_ERROR_CODE || code === 28) return true
    const message = typeof err === 'string' ? err : err instanceof Error ? err.message : ''
    return /password needs to be reset/i.test(message)
}
