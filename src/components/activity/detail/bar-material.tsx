// The pinned sheet bar's material: the solid pre-glass card that fades in with
// the iOS large-title handoff (--bar-bg) and drops its bottom line and shadow
// while a section header is stuck under it (the two then read as one block).
export function PinnedBarMaterial() {
    return (
        <div
            data-bar-solid=""
            aria-hidden="true"
            className="pointer-events-none absolute -inset-x-2 -top-3 bottom-0 border-b border-border/60 bg-card shadow-lg group-data-[joined=true]/bar:border-b-transparent group-data-[joined=true]/bar:shadow-none"
            style={{ opacity: 'var(--bar-bg)' }}
        />
    )
}
