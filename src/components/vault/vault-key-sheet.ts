// Pure helpers for the vault entry sheet. They run directly in node:test.

export interface ExpirySource {
    status?: 'none' | 'active' | 'expired' | 'error'
    daysRemaining?: number | null
    expiresAt?: string | null
}

export type ExpiryState = 'active' | 'expiring' | 'expired' | 'error'

export interface ExpiryInfo {
    state: ExpiryState
    /** ISO timestamp from health, or a YYYY-MM-DD manual date; the caller formats it. */
    date: string | null
}

// The Overview Key row stays masked even when revealed: at most the first four characters.
export function maskedKeyDisplay(value: string, revealed: boolean): string {
    if (!value) return 'Not set'
    // A fixed dot count so the mask does not reveal the key's length.
    if (!revealed || value.length < 8) return '•'.repeat(16)
    return `${value.slice(0, 4)} •••• •••• ••••`
}

// Expiry row source of truth: live provider health first, then the manual date on custom entries.
export function resolveExpiry(health: ExpirySource | undefined, customExpiry: string): ExpiryInfo | null {
    if (health && health.status && health.status !== 'none') {
        if (health.status === 'active') {
            const expiring = health.daysRemaining != null && health.daysRemaining <= 30
            return { state: expiring ? 'expiring' : 'active', date: health.expiresAt ?? null }
        }
        return { state: health.status, date: health.expiresAt ?? null }
    }
    const manual = customExpiry.trim()
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(manual)
    if (!match) return null
    const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    if (!Number.isFinite(time)) return null
    const now = new Date()
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    return { state: time < today ? 'expired' : 'active', date: manual }
}

// Row copy for an ExpiryInfo; the formatter keeps locale choice with the caller.
export function expiryLabel(info: ExpiryInfo, formatDate: (iso: string) => string): string {
    if (info.state === 'expired') return 'Expired'
    if (info.state === 'error') return 'Check failed'
    if (!info.date) return 'Active'
    return `Active until ${formatDate(info.date)}`
}

// Identity-head status line: state · group · updated, skipping unknown parts.
export function statusLine(parts: Array<string | null | undefined>): string {
    return parts.map(part => (part ?? '').trim()).filter(Boolean).join(' · ')
}

// Required fields live on sub-pages, so Done must open the page that is still missing one.
export function firstMissingField(value: string, name: string): { page: 'key' | 'provider'; id: string } | null {
    if (!value) return { page: 'key', id: 'v-value' }
    if (!name.trim()) return { page: 'provider', id: 'v-name' }
    return null
}
