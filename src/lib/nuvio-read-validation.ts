function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateNuvioRows<T extends object>(value: unknown, fn: string, limit: number, options: { allowFullPage?: boolean } = {}): T[] {
    if (!Array.isArray(value)) throw new Error(`Nuvio RPC ${fn} returned an unexpected response shape`)
    if (value.length > limit || (value.length === limit && !options.allowFullPage)) throw new Error(`Nuvio RPC ${fn} reached its page limit; refusing an incomplete snapshot`)
    if (!value.every(row => isRecord(row) && typeof row.content_id === 'string' && row.content_id.length > 0)) {
        throw new Error(`Nuvio RPC ${fn} returned malformed rows`)
    }
    return value as T[]
}
