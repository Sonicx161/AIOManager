// Stremio's own continue-watching rule: only removed && !temp is a real delete. Titles
// watched without being added to the library stay live as removed:true + temp:true rows.
// A user delete of such a row is suppressed by the shipped tombstone mechanisms at
// render and event level, exactly like any other identity.
export function isLiveLibraryRow(item: { removed?: unknown; temp?: unknown }): boolean {
    return item.removed !== true || item.temp === true
}
