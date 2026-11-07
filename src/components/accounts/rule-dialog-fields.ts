export const CUSTOM_WEBHOOK_EMPTY_ERROR = 'Paste a webhook URL or pick Use global webhook'

// An empty custom webhook silently falls back to the global webhook; make the user pick instead.
export function customWebhookError(notifyMode: 'default' | 'custom' | 'off', webhookUrl: string): string | null {
    if (notifyMode === 'custom' && !webhookUrl.trim()) return CUSTOM_WEBHOOK_EMPTY_ERROR
    return null
}

// Cooldown minutes to milliseconds, clamped at zero so negatives can never be saved.
export function parseCooldownMinutes(raw: string): number | undefined {
    if (!raw) return undefined
    const minutes = parseInt(raw, 10)
    if (Number.isNaN(minutes)) return undefined
    return Math.max(0, minutes) * 60 * 1000
}
