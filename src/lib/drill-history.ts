// Pure transitions for the drill-down sheet history (the shared back/forward
// model in useDrillHistory): no imports, so it stays testable under node:test.
export const DRILL_HISTORY_LIMIT = 12

export interface DrillHistoryState<Page> {
    stack: Page[]
    forward: Page[]
}

/** Seed from one page or a chain (Profile then Connections for expired accounts). */
export function initDrillHistory<Page>(pages: Page | Page[]): DrillHistoryState<Page> {
    const stack = (Array.isArray(pages) ? pages : [pages]).slice(-DRILL_HISTORY_LIMIT)
    return { stack: stack.length > 0 ? stack : [pages as Page], forward: [] }
}

/** A push drops the oldest entry past the limit and clears the forward stack. */
export function drillPush<Page>(state: DrillHistoryState<Page>, next: Page): DrillHistoryState<Page> {
    const stack = state.stack.length >= DRILL_HISTORY_LIMIT
        ? [...state.stack.slice(state.stack.length - DRILL_HISTORY_LIMIT + 1), next]
        : [...state.stack, next]
    return { stack, forward: [] }
}

/** Back moves the popped page onto a bounded forward stack; a sole entry cannot pop. */
export function drillBack<Page>(state: DrillHistoryState<Page>): DrillHistoryState<Page> {
    if (state.stack.length <= 1) return state
    const forward = [state.stack[state.stack.length - 1], ...state.forward]
    return { stack: state.stack.slice(0, -1), forward: forward.slice(0, DRILL_HISTORY_LIMIT) }
}

export function drillForward<Page>(state: DrillHistoryState<Page>): DrillHistoryState<Page> {
    if (state.forward.length === 0) return state
    return { stack: [...state.stack, state.forward[0]], forward: state.forward.slice(1) }
}
