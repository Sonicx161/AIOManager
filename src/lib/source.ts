import { loader } from 'fumadocs-core/source';
import { searchIndexed, type IndexedDoc, type DocSearchResult } from './doc-search';
import { DOCS_FRONTMATTER } from './docs-frontmatter';

// The corpus is split: the sidebar tree resolves from generated frontmatter
// data, while each MDX body (with its toc and structuredData) loads on first
// visit and the whole corpus loads only when the search index is requested.
const docs = import.meta.glob('../../content/docs/**/*.{md,mdx}');
const metas = import.meta.glob('../../content/docs/**/meta.json', { eager: true, import: 'default' });

function cleanPagePath(raw: string): string {
    const path = raw.replace('../../content/docs/', '');
    if (path === 'index.mdx' || path === 'index.md') return '';
    return path.replace(/\.mdx?$/, '');
}

interface DocsModule {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    default: (props: any) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toc: any;
    frontmatter?: { title?: string; description?: string };
    structuredData?: {
        headings?: Array<{ id?: string; content?: string }>;
        contents?: Array<{ content?: string }>;
    };
}

const loaders = new Map<string, () => Promise<DocsModule>>();
for (const [raw, load] of Object.entries(docs)) {
    loaders.set(cleanPagePath(raw), load as () => Promise<DocsModule>);
}

// One cached promise per path so React use() sees a stable identity.
const moduleCache = new Map<string, Promise<DocsModule>>();
export function loadPageModule(path: string): Promise<DocsModule> | undefined {
    let cached = moduleCache.get(path);
    if (!cached) {
        const load = loaders.get(path);
        if (!load) return undefined;
        cached = load().catch((error: unknown) => {
            moduleCache.delete(path);
            throw error;
        });
        moduleCache.set(path, cached);
    }
    return cached;
}

const files = [
    ...Object.entries(DOCS_FRONTMATTER).map(([cleanPath, frontmatter]) => ({
        type: 'page' as const,
        path: cleanPath,
        data: {
            ...frontmatter,
            load: () => loadPageModule(cleanPath),
        },
    })),
    ...Object.entries(metas).map(([path, data]: [string, unknown]) => {
        const cleanPath = path
            .replace('../../content/docs/', '')
            .replace('/meta.json', '')
            .replace(/\/$/, '');

        return {
            type: 'meta' as const,
            path: cleanPath,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: data as any,
        };
    }),
];

export const source = loader({
    baseUrl: '/kronorium',
    source: {
        files,
    },
});

// The search index needs every page's structuredData, so it is built from the
// full corpus on first request (first search open) and cached for the session.
let indexPromise: Promise<IndexedDoc[]> | null = null;

export function ensureDocsSearchIndex(): Promise<IndexedDoc[]> {
    indexPromise ??= Promise.all(
        [...loaders.entries()].map(async ([path, load]) => {
            const mod = await load();
            const fm = mod.frontmatter ?? {};
            // fumadocs-mdx's structuredData carries already-extracted plain text: headings ({id, content})
            // and contents (body split by section). Use it instead of toc, whose title is a ReactNode, so
            // calling .toLowerCase() on that threw and silently aborted every search.
            const sd = mod.structuredData ?? {};
            const headings = (sd.headings ?? []) as Array<{ id?: string; content?: string }>;
            const contents = (sd.contents ?? []) as Array<{ content?: string }>;
            // Section landing pages (folder/index.mdx) live at the folder root in fumadocs' loader -
            // an indexed '/kronorium/addons/index' url would 404 where '/kronorium/addons' resolves.
            const canonicalPath = path && path !== 'index' ? path.replace(/\/index$/, '') : '';
            return {
                id: path || 'index',
                title: fm.title || path || 'Home',
                url: canonicalPath ? `/kronorium/${canonicalPath}` : '/kronorium',
                description: fm.description || '',
                headings: headings.map((h) => ({ id: h.id ?? '', content: h.content ?? '' })),
                body: contents.map((c) => c.content ?? '').join(' '),
            };
        }),
    ).catch((error: unknown) => {
        // A failed fetch must not poison the index for the whole tab session.
        indexPromise = null;
        throw error;
    });
    return indexPromise;
}

// In-memory client search. fumadocs' static client always fetches an exported index from a URL
// (no such endpoint in this SPA), so we wire this through useDocsSearch({ client }) instead.
// Async: the first call pulls the corpus chunks and builds the index.
export function searchDocs(query: string): Promise<DocSearchResult[]> {
    if (!query.trim()) return Promise.resolve([]);
    return ensureDocsSearchIndex().then((docsIndexed) => searchIndexed(query, docsIndexed));
}
