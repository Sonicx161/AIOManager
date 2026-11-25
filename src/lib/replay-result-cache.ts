export function currentTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    } catch {
        return ''
    }
}

/** Replay buckets are local-time months, so a result only holds for the month and zone it was computed in. */
export function replayClockKey(now: Date, zone: string = currentTimeZone()): string {
    return `${now.getFullYear()}-${now.getMonth()}|${zone}`
}

interface Entry<V> {
    items: object
    period: number | string
    canonical: object
    clock: string
    value: V
}

/** Results for the current rows only: a new rows array drops every entry, since old entries could never hit again. */
export class ReplayResultCache<V> {
    private readonly max: number
    private rows: object | null = null
    private entries: Entry<V>[] = []

    constructor(max = 6) {
        this.max = max
    }

    setRows(rows: object): void {
        if (rows === this.rows) return
        this.rows = rows
        this.entries = []
    }

    get(items: object, period: number | string, canonical: object, clock: string, compute: () => V): V {
        const hit = this.entries.find(entry => entry.items === items && entry.period === period && entry.canonical === canonical && entry.clock === clock)
        if (hit) return hit.value
        const value = compute()
        this.entries = [{ items, period, canonical, clock, value }, ...this.entries].slice(0, this.max)
        return value
    }

    clear(): void {
        this.rows = null
        this.entries = []
    }

    get size(): number {
        return this.entries.length
    }
}
