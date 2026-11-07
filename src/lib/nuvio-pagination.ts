import { validateNuvioRows } from './nuvio-read-validation.ts'

export const NUVIO_PAGE_SIZE = 1_000
export const NUVIO_MAX_ROWS = 100_000
export const NUVIO_MAX_PAGES = 100

type NuvioRow = Record<string, unknown>

function pageKey(rows: object[]): string {
    return rows.map(row => {
        const value = row as NuvioRow
        return `${String(value.content_id)}|${String(value.season ?? '')}|${String(value.episode ?? '')}|${String(value.video_id ?? '')}`
    }).join('|')
}

export async function pullNuvioWatchedPages<T extends object = NuvioRow>(
    readPage: (page: number, pageSize: number) => Promise<unknown>,
    options: { page?: number; pageSize?: number } = {},
): Promise<T[]> {
    if (options.page !== undefined || options.pageSize !== undefined) {
        const pageSize = options.pageSize ?? NUVIO_PAGE_SIZE
        return validateNuvioRows<T>(await readPage(options.page ?? 1, pageSize), 'sync_pull_watched_items', pageSize, { allowFullPage: true })
    }
    const rows: T[] = []
    const seenPages = new Set<string>()
    for (let page = 1; page <= NUVIO_MAX_PAGES; page++) {
        const pageRows = validateNuvioRows<T>(await readPage(page, NUVIO_PAGE_SIZE), 'sync_pull_watched_items', NUVIO_PAGE_SIZE, { allowFullPage: true })
        if (pageRows.length === 0) return rows
        const key = pageKey(pageRows)
        if (seenPages.has(key)) throw new Error('Nuvio watched history repeated a page; refusing an incomplete snapshot')
        seenPages.add(key)
        rows.push(...pageRows)
        if (rows.length > NUVIO_MAX_ROWS) throw new Error('Nuvio watched history exceeded the safety row limit; refusing an incomplete snapshot')
        if (pageRows.length < NUVIO_PAGE_SIZE) return rows
    }
    throw new Error('Nuvio watched history exceeded the safety page limit; refusing an incomplete snapshot')
}
