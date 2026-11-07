/**
 * Pure matching and grouping helpers for the command palette.
 *
 * Kept free of React, router, and store imports so the matching rules stay
 * trivially testable and reusable. The matching contract is deliberately
 * strict substring containment: every whitespace separated query token must
 * appear somewhere in the combined searchable text. There is no fuzzy or
 * edit distance matching on purpose, so a mistyped query can never match
 * (and therefore never execute) an unrelated command.
 */

import { normalizeAddonUrl } from './addon-url.ts'

export interface CommandSearchFields {
    /** Primary display label. Matched raw, even when the UI renders it masked. */
    label: string
    /** Optional secondary line shown under the label. */
    sublabel?: string
    /** Group name, for example "Navigation" or "Accounts". */
    category?: string
    /** Extra raw text that should match but is never rendered. */
    searchText?: string
    /** Plain language synonyms for the item. */
    aliases?: string[]
}

/**
 * Normalize text for searching: lowercase, strip diacritics, and collapse
 * runs of whitespace into single spaces.
 */
export function normalizeCommandText(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

/** Split a query into normalized tokens, dropping empty fragments. */
export function tokenizeCommandQuery(query: string): string[] {
    return normalizeCommandText(query)
        .split(' ')
        .filter(Boolean)
}

/** Build the combined normalized haystack for one item's matchable fields. */
export function commandHaystack(fields: CommandSearchFields): string {
    const parts = [
        fields.label,
        fields.sublabel ?? '',
        fields.category ?? '',
        fields.searchText ?? '',
        ...(fields.aliases ?? []),
    ]
    return normalizeCommandText(parts.filter(Boolean).join(' '))
}

/** True when every query token is contained in the item haystack. */
export function commandMatchesQuery(query: string, fields: CommandSearchFields): boolean {
    const tokens = tokenizeCommandQuery(query)
    if (tokens.length === 0) return true
    const haystack = commandHaystack(fields)
    if (haystack.length === 0) return false
    return tokens.every((token) => haystack.includes(token))
}

// Haystacks are pure functions of the item's own matchable fields. Palette items
// are rebuilt only when their sources change and are never mutated in place, so
// the normalized haystack can be cached per object identity and reused across
// keystrokes. The cached value is exactly what commandHaystack would return.
const haystackCache = new WeakMap<object, string>()

function cachedHaystack(item: CommandSearchFields): string {
    const cached = haystackCache.get(item)
    if (cached !== undefined) return cached
    const haystack = commandHaystack(item)
    haystackCache.set(item, haystack)
    return haystack
}

/**
 * Filter a list of items against a multiword query. An empty or whitespace
 * only query returns the input unchanged.
 */
export function filterCommandsByQuery<T extends CommandSearchFields>(items: T[], query: string): T[] {
    const tokens = tokenizeCommandQuery(query)
    if (tokens.length === 0) return items
    return items.filter((item) => {
        const haystack = cachedHaystack(item)
        if (haystack.length === 0) return false
        return tokens.every((token) => haystack.includes(token))
    })
}

export interface CommandGroup<T> {
    category: string
    items: T[]
}

/**
 * Group items by category in a stable visual order.
 *
 * Categories listed in categoryOrder come first, in that order. Any category
 * not present in the order (for example future categories) keeps its
 * first appearance order after the known ones. Items inside a category keep
 * their relative input order. The flattened output of the returned groups is
 * the authoritative visual order the keyboard navigation must follow.
 */
export function groupCommandsByCategory<T extends { category: string }>(
    items: T[],
    categoryOrder: readonly string[]
): CommandGroup<T>[] {
    const byCategory = new Map<string, T[]>()
    for (const item of items) {
        const list = byCategory.get(item.category)
        if (list) {
            list.push(item)
        } else {
            byCategory.set(item.category, [item])
        }
    }
    const ordered = new Set<string>()
    for (const category of categoryOrder) {
        if (byCategory.has(category)) ordered.add(category)
    }
    for (const category of byCategory.keys()) {
        ordered.add(category)
    }
    return [...ordered].map((category) => ({
        category,
        items: byCategory.get(category) ?? [],
    }))
}

/** Drop saved addons whose install URL matches an earlier one after normalization. */
export function dedupeByInstallUrl<T extends { installUrl?: string }>(addons: T[]): T[] {
    const seen = new Set<string>()
    return addons.filter((addon) => {
        const key = normalizeAddonUrl(addon.installUrl ?? '')
        if (!key) return true
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}
