// Pure arbitration for the shared per-dialog Alt+Left/Right history stack.
// One registration stack per dialog mirrors the Escape backStack: dispatch goes
// to the deepest active owner of the topmost dialog that contains the event
// target, and an owner stays registered while either direction is available.
// No DOM or React imports, so it stays testable under node:test.

export interface DialogNavEntry {
    canBack: () => boolean
    canForward: () => boolean
    back: () => void
    forward: () => void
}

export interface DialogNavHost {
    /** Ref to the sheet root; containment decides which dialog owns a key. */
    rootRef: { current: { contains(target: Node): boolean } | null }
}

/**
 * True when this host must handle the event: the target sits inside its sheet,
 * or the target is page level (focus fell to body) and no later-opened sheet
 * exists. A sheet that contains the target always wins, so a nested dialog
 * suspends the parent's shortcuts instead of double-handling them.
 */
export function hostOwnsKeyEvent(
    host: DialogNavHost,
    hosts: DialogNavHost[],
    target: Node | null,
    pageLevelTarget: boolean,
): boolean {
    const root = host.rootRef.current
    if (root && target && root.contains(target)) return true
    const insideAnother = hosts.some(other => {
        if (other === host) return false
        const otherRoot = other.rootRef.current
        return !!otherRoot && !!target && otherRoot.contains(target)
    })
    if (insideAnother) return false
    return pageLevelTarget && hosts[hosts.length - 1] === host
}

/**
 * The deepest registered owner handles the key, and only when it can: owners
 * stay registered while Back or Forward is available, so a list holding just a
 * Forward entry still receives Alt+Right. There is no fallthrough, so the
 * parent never acts on a key the child claimed.
 */
export function dispatchAltNav(entries: DialogNavEntry[], key: string): boolean {
    const owner = entries[entries.length - 1]
    if (!owner) return false
    if (key === 'ArrowLeft' ? owner.canBack() : owner.canForward()) {
        if (key === 'ArrowLeft') owner.back()
        else owner.forward()
        return true
    }
    return false
}
