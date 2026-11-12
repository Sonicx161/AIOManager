export type UrlTestStatus = 'ok' | 'fail' | 'checking'
export type UrlTestResult = { status: UrlTestStatus; code?: number; error?: string }
export type UrlTestResults = Record<string, UrlTestResult>

export interface UrlTestRowLike {
    rowId: string
    url: string
}

interface UrlTestResponseLike {
    ok: boolean
    status?: number
    error?: string
    data?: { ok?: boolean; status?: number; error?: string } | null
}

let checkRowSeq = 0
export const nextCheckRowId = (): string => `check-row-${++checkRowSeq}`

let testTokenSeq = 0

// In-flight tests hold numbered claims on rows; edits, removals, and newer tests release them, so late responses never land elsewhere.
export class UrlTestBoard<Row extends UrlTestRowLike = UrlTestRowLike> {
    private claims = new Map<string, number>()
    private readonly getRows: () => readonly Row[]
    private readonly run: (url: string) => Promise<UrlTestResponseLike>
    private readonly setResults: (update: (prev: UrlTestResults) => UrlTestResults) => void

    constructor(
        getRows: () => readonly Row[],
        run: (url: string) => Promise<UrlTestResponseLike>,
        setResults: (update: (prev: UrlTestResults) => UrlTestResults) => void
    ) {
        this.getRows = getRows
        this.run = run
        this.setResults = setResults
    }

    start(rowId: string): Promise<void> {
        const url = this.getRows().find(row => row.rowId === rowId)?.url.trim()
        if (!url) return Promise.resolve()
        const token = ++testTokenSeq
        this.claims.set(rowId, token)
        this.setResults(prev => ({ ...prev, [rowId]: { status: 'checking' } }))
        return this.settle(rowId, url, token)
    }

    release(rowId: string): void {
        this.claims.delete(rowId)
        this.setResults(prev => {
            if (prev[rowId]?.status !== 'checking') return prev
            const next = { ...prev }
            delete next[rowId]
            return next
        })
    }

    forget(rowId: string): void {
        this.claims.delete(rowId)
        this.setResults(prev => {
            if (!(rowId in prev)) return prev
            const next = { ...prev }
            delete next[rowId]
            return next
        })
    }

    releaseAll(): void {
        this.claims.clear()
    }

    private async settle(rowId: string, url: string, token: number): Promise<void> {
        let response: UrlTestResponseLike
        try {
            response = await this.run(url)
        } catch {
            response = { ok: false, error: 'Request failed' }
        }
        if (!this.holds(rowId, token)) return
        this.setResults(prev => ({ ...prev, [rowId]: this.mapResponse(response) }))
    }

    private holds(rowId: string, token: number): boolean {
        return this.claims.get(rowId) === token && this.getRows().some(row => row.rowId === rowId)
    }

    private mapResponse(response: UrlTestResponseLike): UrlTestResult {
        if (!response.ok) return { status: 'fail', error: response.error || `Server error (${response.status})` }
        const data = response.data
        return { status: data?.ok ? 'ok' : 'fail', code: data?.status, error: data?.error }
    }
}
