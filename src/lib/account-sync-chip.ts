const MAX_ERROR_LENGTH = 400
const FALLBACK_ERROR = 'Last sync attempt failed'

export function normalizeSyncError(error: string | null | undefined): string {
    const text = (error ?? '').trim()
    if (!text) return FALLBACK_ERROR
    return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}...` : text
}
