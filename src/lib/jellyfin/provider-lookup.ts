import type { JellyfinItem, JellyfinItemQuery } from './types.ts'

export type ProviderLookupKind = 'Movie' | 'Series'
export type ProviderName = 'imdb' | 'tmdb' | 'tvdb'

export const PROVIDER_LOOKUP_CHUNK = 25
const PROVIDER_LOOKUP_PAGE = 200
const PROVIDER_LOOKUP_MAX_PAGES = 5

export interface ProviderLookupClient {
    queryUserItemsPage(accessToken: string, userId: string, query: JellyfinItemQuery, signal?: AbortSignal): Promise<{ items: JellyfinItem[]; total: number | null }>
}

export class ProviderFilterIgnoredError extends Error {
    constructor() {
        super('The server answered a provider id lookup with titles that do not carry the requested ids.')
        this.name = 'ProviderFilterIgnoredError'
    }
}

export interface ProviderIdLookup {
    prime(kind: ProviderLookupKind, values: string[], signal: AbortSignal): Promise<void>
    find(kind: ProviderLookupKind, values: string[], signal: AbortSignal): Promise<JellyfinItem[] | null>
    clear(): void
}

export function providerLookupValue(provider: ProviderName, value: string): string {
    return `${provider}.${value.toLowerCase()}`
}

function rawProviderValues(item: JellyfinItem): Set<string> {
    const out = new Set<string>()
    const providers = item.ProviderIds
    if (typeof providers !== 'object' || providers === null) return out
    for (const [key, value] of Object.entries(providers)) {
        if (typeof value === 'string' && value !== '') out.add(`${key.toLowerCase()}.${value.toLowerCase()}`)
    }
    return out
}

export function createProviderIdLookup(client: ProviderLookupClient, auth: { accessToken: string; userId: string }): ProviderIdLookup {
    const settled = new Map<string, JellyfinItem[]>()
    const pending = new Map<string, Promise<void>>()
    let ignored = false
    let generation = 0

    const keyOf = (kind: ProviderLookupKind, value: string) => `${kind}|${value}`

    async function fetchChunk(kind: ProviderLookupKind, values: string[], signal: AbortSignal, runGeneration: number): Promise<void> {
        const wanted = new Set(values)
        const collected: JellyfinItem[] = []
        const seen = new Set<string>()
        let offset = 0
        let total: number | null = null
        let complete = false
        for (let page = 0; page < PROVIDER_LOOKUP_MAX_PAGES; page++) {
            const result = await client.queryUserItemsPage(
                auth.accessToken,
                auth.userId,
                { anyProviderIdEquals: values, includeItemTypes: kind, recursive: true, limit: PROVIDER_LOOKUP_PAGE, startIndex: offset },
                signal
            )
            if (result.total !== null) total = Math.max(total ?? 0, result.total)
            let fresh = 0
            for (const item of result.items) {
                if (![...rawProviderValues(item)].some(value => wanted.has(value))) {
                    ignored = true
                    throw new ProviderFilterIgnoredError()
                }
                if (seen.has(item.Id)) continue
                seen.add(item.Id)
                collected.push(item)
                fresh++
            }
            offset += result.items.length
            if (result.items.length === 0 || fresh === 0) {
                complete = result.items.length === 0 && (total === null || offset >= total)
                break
            }
            if (total !== null ? offset >= total : result.items.length < PROVIDER_LOOKUP_PAGE) {
                complete = true
                break
            }
        }
        if (!complete || runGeneration !== generation) return
        for (const value of values) {
            settled.set(keyOf(kind, value), collected.filter(item => item.Type === kind && rawProviderValues(item).has(value)))
        }
    }

    async function ensure(kind: ProviderLookupKind, values: string[], signal: AbortSignal): Promise<void> {
        if (ignored) throw new ProviderFilterIgnoredError()
        const unique = [...new Set(values)]
        const missing = unique.filter(value => !settled.has(keyOf(kind, value)) && !pending.has(keyOf(kind, value)))
        for (let start = 0; start < missing.length; start += PROVIDER_LOOKUP_CHUNK) {
            const chunk = missing.slice(start, start + PROVIDER_LOOKUP_CHUNK)
            const run = fetchChunk(kind, chunk, signal, generation).finally(() => {
                for (const value of chunk) if (pending.get(keyOf(kind, value)) === run) pending.delete(keyOf(kind, value))
            })
            run.catch(() => {})
            for (const value of chunk) pending.set(keyOf(kind, value), run)
        }
        const waits = new Set<Promise<void>>()
        for (const value of unique) {
            const wait = pending.get(keyOf(kind, value))
            if (wait !== undefined) waits.add(wait)
        }
        await Promise.all(waits)
        if (ignored) throw new ProviderFilterIgnoredError()
    }

    return {
        async prime(kind, values, signal) {
            await ensure(kind, values, signal)
        },
        async find(kind, values, signal) {
            await ensure(kind, values, signal)
            const byId = new Map<string, JellyfinItem>()
            for (const value of new Set(values)) {
                const hits = settled.get(keyOf(kind, value))
                if (hits === undefined) return null
                for (const item of hits) byId.set(item.Id, item)
            }
            return [...byId.values()]
        },
        clear() {
            generation++
            settled.clear()
            pending.clear()
            ignored = false
        },
    }
}
