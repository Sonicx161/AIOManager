// Pure geometry for the Metrics Activity Calendar grid, shared by the
// ContributionGraph renderer and its tests.

export const CALENDAR_CELL = 13
export const CALENDAR_GAP = 3

// A week column stacks 7 cells with GAP between them (cells carry no margins),
// so its intrinsic height is 7*CELL + 6*GAP. Used for content-visibility size
// reservation: off-screen columns must reserve their exact real height or the
// grid shifts when they render.
export function weekColumnIntrinsicSize(cell: number, gap: number): { width: number; height: number } {
    return { width: cell, height: 7 * cell + 6 * gap }
}
