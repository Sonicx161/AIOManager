/** Distinct profiles across the award lists, so the chip never counts one profile twice. */
export function rankedProfileCount(awards: Record<string, ReadonlyArray<{ id: string }> | undefined> | undefined): number {
    const ids = new Set<string>()
    for (const list of Object.values(awards ?? {})) for (const entry of list ?? []) ids.add(entry.id)
    return ids.size
}
