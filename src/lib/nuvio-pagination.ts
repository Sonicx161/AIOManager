export const NUVIO_PAGE_SIZE = 1_000
export const NUVIO_MAX_PAGES = 100
export const NUVIO_SNAPSHOT_LIMIT = 100_000
// One row more than the pages can hold, so a list at the cap reads as incomplete, never as whole.
export const NUVIO_READ_LIMIT = NUVIO_MAX_PAGES * NUVIO_PAGE_SIZE + 1

// A history read that could not be proven complete. Callers keep the last good copy and never
// write after it.
export class NuvioIncompleteReadError extends Error {
    readonly code = 'incomplete_read'
    constructor(message: string) {
        super(message)
        this.name = 'NuvioIncompleteReadError'
    }
}

// Pages follow each row's permanent id ("rows after id K"), never a row count, so rows added or
// removed elsewhere cannot shift a row out of the read.
export interface NuvioPageRequest {
    after: string | null
    limit: number
}

export interface NuvioPageResult {
    rows: unknown
    total: number | null
}

export interface NuvioPagedRows {
    rows: Array<Record<string, unknown>>
    complete: boolean
}

type NuvioRow = Record<string, unknown>

function isRecord(value: unknown): value is NuvioRow {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function nuvioPageQuery(page: NuvioPageRequest): string {
    return `order=id.asc${page.after ? `&id=gt.${encodeURIComponent(page.after)}` : ''}&limit=${page.limit}`
}

export function contentRangeTotal(value: string | null | undefined): number | null {
    const match = /\/(\d+)\s*$/.exec(value ?? '')
    return match ? Number(match[1]) : null
}

export function progressRowKey(row: NuvioRow): string {
    return typeof row.progress_key === 'string' && row.progress_key ? row.progress_key : JSON.stringify([row.content_id ?? null, row.season ?? null, row.episode ?? null, row.video_id ?? null])
}

export function watchedRowKey(row: NuvioRow): string {
    return JSON.stringify([row.content_id ?? null, row.season ?? null, row.episode ?? null])
}

// Same order as Nuvio's pull functions (newest first), with ties broken by row key so two reads
// of the same rows come out identical.
export function newestFirst<T extends object>(rows: T[], field: string, keyOf: (row: NuvioRow) => string): T[] {
    const time = (row: T) => {
        const value = Number((row as NuvioRow)[field])
        return Number.isFinite(value) ? value : 0
    }
    const key = (row: T) => keyOf(row as NuvioRow)
    return rows.slice().sort((a, b) => time(b) - time(a) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}

// Pages by row id; a count that does not add up, a repeated row or an id out of order makes the read incomplete.
export async function pullNuvioPages(
    readPage: (page: NuvioPageRequest) => Promise<NuvioPageResult>,
    options: { keyOf: (row: NuvioRow) => string; maxPages?: number; pageSize?: number },
): Promise<NuvioPagedRows> {
    const maxPages = options.maxPages ?? NUVIO_MAX_PAGES
    const pageSize = options.pageSize ?? NUVIO_PAGE_SIZE
    const rows: NuvioRow[] = []
    const keys = new Set<string>()
    let after: string | null = null
    let expectedRemaining: number | null | undefined
    for (let page = 0; page <= maxPages; page++) {
        const result = await readPage({ after, limit: pageSize })
        if (!Array.isArray(result.rows)) throw new NuvioIncompleteReadError('Nuvio returned an unexpected response shape; nothing was interpreted as data.')
        if (expectedRemaining !== undefined && result.total !== expectedRemaining) return { rows, complete: false }
        for (const row of result.rows) {
            if (!isRecord(row)) throw new NuvioIncompleteReadError('Nuvio returned a malformed row; refusing an incomplete snapshot.')
            const id = row.id
            if (typeof id !== 'string' || !id || (after !== null && id <= after)) return { rows, complete: false }
            const key = options.keyOf(row)
            if (keys.has(key)) return { rows, complete: false }
            keys.add(key)
            rows.push(row)
            after = id
        }
        if (result.rows.length === 0) return { rows, complete: result.total === null || result.total === 0 }
        if (rows.length > maxPages * pageSize) return { rows, complete: false }
        // A count reaching zero on a short page is the end. A full page, or no count, needs an empty
        // page after the last id to prove it.
        if (result.total !== null) {
            expectedRemaining = result.total - result.rows.length
            if (expectedRemaining < 0) return { rows, complete: false }
            if (expectedRemaining === 0 && result.rows.length < pageSize) return { rows, complete: true }
        } else {
            expectedRemaining = null
        }
    }
    return { rows, complete: false }
}
