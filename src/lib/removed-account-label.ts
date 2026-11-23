export function removedAccountLabels(accountIds: Iterable<string>, known: (id: string) => boolean): Map<string, string> {
    const removed = new Set<string>()
    for (const id of accountIds) if (id && !known(id)) removed.add(id)
    const labels = new Map<string, string>()
    for (const id of removed) labels.set(id, removed.size > 1 ? `Removed account ${id.slice(-4)}` : 'Removed account')
    return labels
}
