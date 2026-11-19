// Pure, dependency-free doc search used by the Kronorium. Kept separate from source.ts (which
// uses Vite's import.meta.glob) so the matching logic is unit-testable. See doc-search.test.ts.

export interface IndexedDoc {
    id: string
    title: string
    url: string
    description: string
    headings: Array<{ id: string; content: string }>
    body: string
}

export interface DocSearchResult {
    id: string
    url: string
    type: 'page' | 'heading'
    content: string
}

interface DocSearchEntry {
    doc: IndexedDoc
    title: string
    description: string
    headingText: string
    body: string
    hay: string
    headings: Array<{ id: string; content: string; lower: string }>
}

// Lowercasing every doc body per keystroke dominated search cost. The docs array reference is
// stable for the app lifetime, so the lowercase index is built once per reference — if that
// ever stops holding, this cache silently thrashes and must become an explicit rebuild.
const entryCache = new WeakMap<IndexedDoc[], DocSearchEntry[]>()

function getEntries(docs: IndexedDoc[]): DocSearchEntry[] {
    const cached = entryCache.get(docs)
    if (cached) return cached
    const entries = docs.map(doc => {
        const title = doc.title.toLowerCase()
        const description = doc.description.toLowerCase()
        const headingText = doc.headings.map(h => h.content).join(' ').toLowerCase()
        const body = doc.body.toLowerCase()
        return {
            doc,
            title,
            description,
            headingText,
            body,
            hay: `${title} ${description} ${headingText} ${body}`,
            headings: doc.headings.map(h => ({ id: h.id, content: String(h.content ?? ''), lower: String(h.content ?? '').toLowerCase() })),
        }
    })
    entryCache.set(docs, entries)
    return entries
}

export function searchIndexed(query: string, docs: IndexedDoc[]): DocSearchResult[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const terms = q.split(/\s+/).filter(Boolean)

    const scored: Array<{ score: number; results: DocSearchResult[] }> = []
    for (const entry of getEntries(docs)) {
        if (!terms.every(t => entry.hay.includes(t))) continue

        let score = 0
        if (entry.title.includes(q)) score += 100
        if (terms.every(t => entry.title.includes(t))) score += 40
        if (entry.headingText.includes(q)) score += 20
        if (entry.description.includes(q)) score += 10

        const results: DocSearchResult[] = [{ id: entry.doc.id, url: entry.doc.url, type: 'page', content: entry.doc.title }]
        for (const h of entry.headings) {
            if (terms.some(t => h.lower.includes(t))) {
                results.push({ id: `${entry.doc.id}-${h.id}`, url: `${entry.doc.url}#${h.id}`, type: 'heading', content: h.content })
            }
        }
        scored.push({ score, results })
    }

    return scored
        .sort((a, b) => b.score - a.score)
        .flatMap(s => s.results)
        .slice(0, 40)
}
