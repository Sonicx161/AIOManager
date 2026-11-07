// APPROVED ANIMATED SPECIAL THEMES · 2026-10 · Phase 3
// Same engine contract as theme-css.ts: rules scope to [data-theme-part] only.
// Motion budget: animations exclusively animate transform / opacity /
// background-position (compositor-friendly); static blurs on small decorative
// layers only; no animated filters, shadows or layout properties; every
// animation sits behind @media (prefers-reduced-motion: no-preference).
// Editor-friendly knobs every skin exposes (also editable in the theme
// editor's Custom CSS tab via the FX helper):
//   --fx-duration  base loop duration (speed)
//   --fx-density   texture density (background-size component)
//   --fx-depth     shadow/glow depth (length component)
const parts = (...names: string[]) => `:is(${names.map(name => `[data-theme-part="${name}"]`).join(', ')}):where(:not([data-theme-inset]))`
const SURFACES = parts('card', 'addon-card', 'panel', 'toolbar', 'app-nav', 'mobile-nav', 'mobile-status', 'app-footer', 'footer-nav', 'header-status', 'tabs-list', 'dialog', 'menu', 'popover', 'select-content', 'tooltip', 'toast')
const PAINTED_SURFACES = `${SURFACES}:not([data-theme-tone])`
const ACTIONS = parts('button', 'nav-item', 'tab', 'select-trigger', 'sync-status', 'autopilot-status')
const FIELDS = parts('input', 'textarea', 'field')
const ITEMS = parts('menu-item', 'select-item')
const IMAGE_PARTS = parts('account-avatar', 'account-accent', 'image-tile')
const TOGGLES = `${parts('checkbox', 'switch', 'switch-thumb', 'progress', 'progress-indicator', 'scroll-thumb', 'avatar', 'avatar-fallback', 'skeleton')}, ${IMAGE_PARTS}`
const STATE_DETAILS = `
[data-theme-part="app-header"] { -webkit-backdrop-filter: none; backdrop-filter: none; }
[data-theme-part="app-nav"] { -webkit-backdrop-filter: var(--theme-nav-backdrop, none); backdrop-filter: var(--theme-nav-backdrop, none); }
[data-theme-part="account-avatar"] { --theme-avatar-filter: none; }
[data-theme-part="account-avatar"] :is([data-theme-part="account-avatar-surface"], [data-theme-part="account-avatar-image"]) {
  border-radius: inherit;
}
[data-theme-part="header-status"] [data-theme-segment] {
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
[data-theme-part="header-status"] [data-theme-segment]:not([data-theme-segment="vault"]) {
  border-inline-start: 1px solid hsl(var(--border));
}
[data-theme-part="header-status"] > div:first-child { border-radius: inherit; }
[data-theme-part="header-status"] [data-theme-segment="vault"] {
  border-start-start-radius: inherit;
  border-end-start-radius: inherit;
}
[data-theme-part="header-status"] [data-theme-segment="sync"] {
  border-start-end-radius: inherit;
  border-end-end-radius: inherit;
}
[data-theme-part="header-status"] button[data-theme-segment]:is(:hover, [data-state="open"]) {
  background-color: hsl(var(--muted) / .55);
}
/* A pressed strip cell keeps the transparent strip fill, so it shows state with the accent. */
[data-theme-part="header-status"] button[data-theme-segment][aria-pressed="true"] {
  color: hsl(var(--primary));
}
[data-theme-part="header-status"] button[data-theme-segment]:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: -3px;
}
:is(input[data-theme-part="checkbox"], input[data-theme-part="slider"]) { accent-color: hsl(var(--primary)); }
:is([data-theme-part="card"], [data-theme-part="addon-card"], [data-theme-part="panel"])[data-selected="true"] {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
}
[data-theme-part="tab-indicator"] { border-radius: inherit; background: transparent; box-shadow: none; }
:is([data-theme-part="nav-item"], [data-theme-part="tab"])[data-state="active"] [data-theme-part="badge"] { background-color: transparent; color: inherit; }
`
const FOCUS_RING = `:is(button, input, textarea, select, a):focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 3px; }`
const MOTION_GUARD = '@media (prefers-reduced-motion: no-preference) {'

export const HOLO_LIQUID_CSS = `/* HOLOGRAPHIC LIQUID · Iridescent sheen rolling across pearl panels and buttons. */
:root { --fx-duration: 7s; --fx-depth: 16px; }
[data-theme-part="app-shell"] {
  isolation: isolate;
  background-color: hsl(var(--background));
  background-image: linear-gradient(150deg, hsl(260 40% 97%), hsl(200 50% 95%) 45%, hsl(320 35% 96%));
}
${SURFACES} {
  position: relative; overflow: hidden;
  border: 1px solid hsl(265 30% 78% / .8); border-radius: 14px;
  box-shadow: 0 4px var(--fx-depth, 16px) hsl(265 40% 55% / .14), inset 0 1px 0 hsl(0 0% 100% / .9);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card) / .82); }
/* The liquid: a wide iridescent band sweeps each panel on its own clock. */
${SURFACES}::before {
  content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .55;
  background: linear-gradient(115deg, transparent 32%, hsl(190 90% 70% / .25) 42%, hsl(300 80% 80% / .22) 50%, hsl(60 80% 75% / .2) 58%, transparent 68%);
  background-size: 280% 100%;
}
${ACTIONS} {
  position: relative; overflow: hidden; border: 1px solid hsl(265 25% 75%); border-radius: 9px;
  box-shadow: 0 2px 6px hsl(265 40% 50% / .12);
}
${ACTIONS}::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0;
  background: linear-gradient(115deg, transparent 35%, hsl(300 80% 85% / .5) 50%, transparent 65%);
  background-size: 250% 100%;
}
${FIELDS} { border: 1px solid hsl(265 25% 75%); border-radius: 9px; background: hsl(0 0% 100% / .85); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: linear-gradient(120deg, hsl(265 60% 52%), hsl(300 55% 55%)); color: hsl(0 0% 100%);
  --foreground: 0 0% 100%; --muted-foreground: 0 0% 100%;
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(280 60% 60% / .12); }
${TOGGLES}, ${ITEMS} { border-radius: 8px; }
[data-theme-part="badge"] { border-radius: 999px; border: 1px solid hsl(280 40% 70% / .9); background: hsl(280 60% 85% / .4); }
[data-theme-part="progress-indicator"] { background: linear-gradient(90deg, hsl(265 60% 55%), hsl(190 80% 60%), hsl(320 70% 65%)); background-size: 200% 100%; }
[data-theme-part="app-header"] { background: hsl(265 40% 98% / .9); border-bottom: 1px solid hsl(265 30% 80%); }
${STATE_DETAILS}
${FOCUS_RING}
${MOTION_GUARD}
  ${SURFACES}::before { animation: holo-sheen var(--fx-duration, 7s) linear infinite; }
  ${SURFACES}:nth-of-type(2n)::before { animation-delay: calc(var(--fx-duration, 7s) / -2); }
  ${SURFACES}:nth-of-type(3n)::before { animation-delay: calc(var(--fx-duration, 7s) / -3); }
  ${ACTIONS}:is(:hover, :focus-visible)::after { opacity: 1; animation: holo-sheen 1.4s linear infinite; }
  [data-theme-part="progress-indicator"] { animation: holo-flow 3s linear infinite; }
}
@keyframes holo-sheen { from { background-position: 280% 0; } to { background-position: -80% 0; } }
@keyframes holo-flow { from { background-position: 0 0; } to { background-position: 200% 0; } }
`

export const TIDAL_PULSE_CSS = `/* TIDAL PULSE · Two wave layers lap the bottom; progress bars surf. */
:root { --fx-duration: 9s; --fx-depth: 14px; }
[data-theme-part="app-shell"] {
  isolation: isolate;
  background-color: hsl(var(--background));
  background-image: linear-gradient(180deg, hsl(195 70% 95%), hsl(200 60% 91%));
}
/* Waves: wide repeating scallop tiles translating horizontally, out of phase. */
[data-theme-part="app-shell"]::before, [data-theme-part="app-shell"]::after {
  content: ''; position: fixed; left: 0; right: 0; bottom: -8px; height: 26vh; z-index: -1; pointer-events: none;
  background-repeat: repeat-x; background-size: 340px 100%;
}
[data-theme-part="app-shell"]::before {
  background-image: radial-gradient(circle at 50% 118%, transparent 46%, hsl(195 80% 82% / .8) 47% 60%, transparent 61%);
  opacity: .8;
}
[data-theme-part="app-shell"]::after {
  background-image: radial-gradient(circle at 50% 130%, transparent 52%, hsl(190 75% 74% / .7) 53% 66%, transparent 67%);
  opacity: .6;
}
${SURFACES} {
  border: 1px solid hsl(196 55% 72% / .9); border-radius: 13px;
  box-shadow: 0 4px var(--fx-depth, 14px) hsl(200 60% 45% / .16), inset 0 1px 0 hsl(0 0% 100% / .9);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card) / .85); }
${ACTIONS}, ${FIELDS} { border: 1px solid hsl(196 50% 70%); border-radius: 10px; }
${FIELDS} { background: hsl(0 0% 100% / .85); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: linear-gradient(140deg, hsl(200 75% 44%), hsl(172 65% 44%)); color: hsl(0 0% 100%);
  --foreground: 0 0% 100%; --muted-foreground: 0 0% 100%;
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(195 75% 55% / .14); }
${TOGGLES}, ${ITEMS} { border-radius: 9px; }
[data-theme-part="badge"] { border-radius: 999px; border: 1px solid hsl(195 55% 68%); background: hsl(195 70% 90% / .5); }
/* The sync progress bar becomes a breaking wave. */
[data-theme-part="progress-indicator"] {
  background-color: hsl(200 75% 48%);
  background-image: repeating-linear-gradient(110deg, hsl(186 85% 70% / .8) 0 8px, transparent 8px 18px);
}
[data-theme-part="app-header"] { background: hsl(198 65% 97% / .9); border-bottom: 1px solid hsl(196 55% 76%); }
${STATE_DETAILS}
${FOCUS_RING}
${MOTION_GUARD}
  [data-theme-part="app-shell"]::before { animation: tide-a var(--fx-duration, 9s) linear infinite; }
  [data-theme-part="app-shell"]::after { animation: tide-b calc(var(--fx-duration, 9s) * 1.6) linear infinite reverse; }
  [data-theme-part="progress-indicator"] { animation: tide-flow 1.8s linear infinite; }
}
@keyframes tide-a { from { background-position: 0 0; } to { background-position: 340px 0; } }
@keyframes tide-b { from { background-position: 0 0; } to { background-position: -340px 0; } }
@keyframes tide-flow { from { background-position: 0 0; } to { background-position: 36px 0; } }
`
