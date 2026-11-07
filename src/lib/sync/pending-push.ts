// Platform-scoped reasons carry the platform id after the prefix, e.g. 'read-failed-nuvio'.
export type PendingPushReason =
    | 'resurrected'
    | 'manifest'
    | 'push-blocked'
    | `removed-${string}`
    | `push-blocked-${string}`
    | `push-skipped-${string}`
    | `read-failed-${string}`

const EMPTY: readonly PendingPushReason[] = Object.freeze([])
const pending = new Map<string, readonly PendingPushReason[]>()
const pendingResurrected = new Map<string, number>()
const listeners = new Set<() => void>()
const EMPTY_ALL: ReadonlyArray<readonly [string, readonly PendingPushReason[]]> = Object.freeze([])
let allSnapshot = EMPTY_ALL
let allResurrectedSnapshot: ReadonlyMap<string, number> = new Map()

function notify() {
    allSnapshot = pending.size === 0 ? EMPTY_ALL : Object.freeze([...pending.entries()])
    allResurrectedSnapshot = new Map(pendingResurrected)
    for (const listener of listeners) listener()
}

export function setPendingPush(accountId: string, reasons: Iterable<PendingPushReason>): void {
    const next = [...new Set(reasons)].sort()
    const current = pending.get(accountId) ?? EMPTY
    const sameReasons = next.length === current.length && next.every((r, i) => r === current[i])
    if (sameReasons) return
    if (!next.includes('resurrected')) pendingResurrected.delete(accountId)
    if (next.length === 0) pending.delete(accountId)
    else pending.set(accountId, Object.freeze(next))
    notify()
}

/** How many addons the 'resurrected' reason covers; kept only while that reason is set. */
export function setPendingResurrectedCount(accountId: string, count: number): void {
    const next = getPendingPush(accountId).includes('resurrected') && count > 0 ? count : 0
    if ((pendingResurrected.get(accountId) ?? 0) === next) return
    if (next > 0) pendingResurrected.set(accountId, next)
    else pendingResurrected.delete(accountId)
    notify()
}

export function getAllPendingResurrected(): ReadonlyMap<string, number> {
    return allResurrectedSnapshot
}

export function getPendingPush(accountId: string): readonly PendingPushReason[] {
    return pending.get(accountId) ?? EMPTY
}

export function getAllPendingPush(): ReadonlyArray<readonly [string, readonly PendingPushReason[]]> {
    return allSnapshot
}

export function clearPendingPush(accountId: string): void {
    setPendingPush(accountId, [])
}

export function subscribePendingPush(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}
