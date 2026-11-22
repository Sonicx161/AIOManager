export function topmostOwner<T extends { rootRef: { current: unknown } }>(hosts: readonly T[]): T | null {
    for (let i = hosts.length - 1; i >= 0; i--) {
        if (hosts[i].rootRef.current) return hosts[i]
    }
    return null
}
