/**
 * Pure scroll math for the activity detail sheet's hero and large-title bar.
 *
 * Coordinate spaces: content elements (hero, hero title, actions) are doc-space
 * offsets from the scroller's content origin, so they stay constant while only
 * scrollTop changes. Bar parts are pinned overlays: their offsets are measured
 * from the scroller's top edge in viewport space (no scrollTop term), which is
 * what makes the collapse window stable across re-measures at any scroll.
 * The caller measures once per layout change; every scroll frame is then a
 * plain function of scrollTop.
 *
 * iOS-style handoff: the large hero title scrolls with the content and is never
 * moved by script, so it cannot lag behind compositor scrolling. It fades out as
 * it reaches the bar, and only then do the bar's own title and thumbnail fade in,
 * so the two titles are never visible at the same time.
 */

export interface HeroCollapseGeometry {
    barHeight: number
    /** Bar title text box (where the small title appears). */
    barTitleTop: number
    barTitleHeight: number
    heroBottom: number
    /** Hero title box (text or logo), as laid out over the artwork. */
    heroTitleTop: number
    heroTitleHeight: number
    /** Hero action buttons row. */
    actionsBottom: number
}

export interface HeroCollapseOptions {
    /** Scroll px over which the bar background fades from 0 to 1 (24..40). */
    bgFadeRange?: number
}

export interface HeroCollapseFrame {
    /** Solid bar background opacity. */
    bg: number
    /** Title handoff progress 0..1. */
    title: number
    /** Bar Play reveal 0..1. */
    play: number
    heroTitleOpacity: number
    barTitleOpacity: number
    /** Bar poster thumbnail opacity. */
    thumb: number
}

const BG_FADE_RANGE = 32
// The hero title is fully gone at 0.75, the bar title only starts at 0.8.
const HERO_FADE_START = 0.6
const HERO_FADE_END = 0.75
const BAR_FADE_START = 0.8
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Scroll positions where the title handoff starts and completes. */
export function heroCollapseWindow(g: HeroCollapseGeometry): { start: number; end: number } {
    const end = g.heroTitleTop - g.barTitleTop
    const span = g.heroTitleHeight + g.barHeight
    const start = end - span
    return end > start ? { start, end } : { start, end: start + 1 }
}

export function heroCollapseState(
    scrollTop: number,
    g: HeroCollapseGeometry,
    opts: HeroCollapseOptions = {},
): HeroCollapseFrame {
    const range = opts.bgFadeRange ?? BG_FADE_RANGE

    const heroBottomViewport = g.heroBottom - scrollTop
    const bg = clamp01((g.barHeight + range - heroBottomViewport) / range)

    const { start, end } = heroCollapseWindow(g)
    const hasTitle = g.heroTitleHeight > 0 && g.barTitleHeight > 0
    const p = hasTitle ? clamp01((scrollTop - start) / (end - start)) : 0

    // Unmeasured (a logo still loading) stays visible in the hero.
    const heroTitleOpacity = hasTitle ? clamp01((HERO_FADE_END - p) / (HERO_FADE_END - HERO_FADE_START)) : 1
    const barTitleOpacity = hasTitle ? clamp01((p - BAR_FADE_START) / (1 - BAR_FADE_START)) : 0

    return {
        bg,
        title: p,
        play: clamp01((scrollTop - (g.actionsBottom - g.barHeight)) / 24),
        heroTitleOpacity,
        barTitleOpacity,
        thumb: barTitleOpacity,
    }
}
