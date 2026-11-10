// Extends a sync ownership guard with a scope captured at the start of the work
// (sync endpoint and identity). A continuation that outlives a server switch stops
// passing current()/assert(), so a response from the old server is never applied.

interface OwnershipLike {
    current(): boolean
    assert(): void
}

export function bindOwnershipScope<T extends OwnershipLike>(ownership: T, readScope: () => string, lost: () => Error): T {
    const captured = readScope()
    const current = () => ownership.current() && readScope() === captured
    const assert = () => {
        ownership.assert()
        if (readScope() !== captured) throw lost()
    }
    return { ...ownership, current, assert }
}
