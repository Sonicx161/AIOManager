// One badge abbreviation helper for every provider tile and the header badge input.
export function providerAbbr(name: string): string {
    return name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '··'
}

// Expiry values must be a real ISO calendar date (YYYY-MM-DD) or empty; anything else is an inline error.
export function expiryDateError(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return 'Enter the date as YYYY-MM-DD.'
    const [y, m, d] = trimmed.split('-').map(Number)
    const date = new Date(Date.UTC(y, m - 1, d))
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
        return 'That date does not exist.'
    }
    return null
}
