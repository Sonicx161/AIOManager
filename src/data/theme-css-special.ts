// APPROVED SPECIAL THEMES · 2026-10 · Signature UI treatments beyond color.
// Pruned 2026-10 to the approved set; animated approved skins live in theme-css-animated.ts.
// Same engine contract as theme-css.ts: every rule scopes to [data-theme-part]
// so clones keep their full appearance and default global styles stay untouched.
// Decorative layers sit behind the UI (fixed, z-index -1, pointer-events none),
// animations are opt-in via prefers-reduced-motion, and fonts/contrast/geometry
// stay within the app's accessibility baseline.
const parts = (...names: string[]) => `:is(${names.map(name => `[data-theme-part="${name}"]`).join(', ')}):where(:not([data-theme-inset]))`
const SURFACES = parts('card', 'addon-card', 'panel', 'toolbar', 'app-nav', 'mobile-nav', 'mobile-status', 'app-footer', 'footer-nav', 'header-status', 'tabs-list', 'dialog', 'menu', 'popover', 'select-content', 'tooltip', 'toast')
const PAINTED_SURFACES = `${SURFACES}:not([data-theme-tone])`
const ACTIONS = parts('button', 'nav-item', 'tab', 'select-trigger', 'sync-status', 'autopilot-status')
const FIELDS = parts('input', 'textarea', 'field')
const ITEMS = parts('menu-item', 'select-item')
const IMAGE_PARTS = parts('account-avatar', 'account-accent', 'image-tile')
const TOGGLES = `${parts('checkbox', 'switch', 'switch-thumb', 'progress', 'progress-indicator', 'scroll-thumb', 'avatar', 'avatar-fallback', 'skeleton')}, ${IMAGE_PARTS}`
const STATE_DETAILS = `
/* Opaque theme chrome does not need to keep blurring animated scenery.
   Glass themes can opt their navigation back into a small blur explicitly. */
[data-theme-part="app-header"] { -webkit-backdrop-filter: none; backdrop-filter: none; }
[data-theme-part="app-nav"] { -webkit-backdrop-filter: var(--theme-nav-backdrop, none); backdrop-filter: var(--theme-nav-backdrop, none); }
/* Account artwork keeps its colors and inherits the skin's silhouette. */
[data-theme-part="account-avatar"] { --theme-avatar-filter: none; }
[data-theme-part="account-avatar"] :is([data-theme-part="account-avatar-surface"], [data-theme-part="account-avatar-image"]) {
  border-radius: inherit;
}
/* A connected status strip has one frame; its cells share dividers. */
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
/* Native preference controls use the same accent as shared controls. */
:is(input[data-theme-part="checkbox"], input[data-theme-part="slider"]) { accent-color: hsl(var(--primary)); }
/* Keep selection visible when the skin replaces a card's border and shadow. */
:is([data-theme-part="card"], [data-theme-part="addon-card"], [data-theme-part="panel"])[data-selected="true"] {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
}
/* Let the selected control paint its own highlight without an inner pill covering it. */
[data-theme-part="tab-indicator"] { border-radius: inherit; background: transparent; box-shadow: none; }
:is([data-theme-part="nav-item"], [data-theme-part="tab"])[data-state="active"] [data-theme-part="badge"] { background-color: transparent; color: inherit; }
`
const FOCUS_RING = `:is(button, input, textarea, select, a):focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 3px; }`

export const DOT_MATRIX_CSS = `/* DOT MATRIX · Handheld olive LCD: pixel grid, ink frames and inverted selections. */
body { font-family: 'Courier New', ui-monospace, monospace; }
[data-theme-part="app-shell"] {
  background-color: hsl(var(--background));
  background-image: radial-gradient(hsl(75 30% 12% / .14) 1px, transparent 1px);
  background-size: 3px 3px;
}
${SURFACES} { border: 2px solid hsl(75 35% 12% / .85); border-radius: 0; box-shadow: 3px 3px 0 hsl(75 35% 12% / .3); }
${PAINTED_SURFACES} { background-color: hsl(var(--card)); }
${ACTIONS}, ${FIELDS} { border: 2px solid hsl(75 35% 12% / .85); border-radius: 0; font-family: inherit; font-weight: 700; }
${FIELDS} { background: hsl(75 25% 88%); box-shadow: inset 2px 2px 0 hsl(75 35% 12% / .25); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]), ${ACTIONS}:hover {
  background: hsl(75 35% 14%); color: hsl(75 25% 90%);
  --foreground: 75 25% 90%; --muted-foreground: 75 25% 90%;
  box-shadow: 2px 2px 0 hsl(75 35% 12% / .5);
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(75 35% 14% / .14); box-shadow: inset 3px 0 0 hsl(75 35% 14%); }
${TOGGLES}, ${ITEMS}, [data-theme-part="badge"] { border-radius: 0; }
[data-theme-part="badge"] { border: 2px solid hsl(75 35% 12% / .8); font-family: inherit; text-transform: uppercase; letter-spacing: .04em; }
h1, h2, h3 { font-family: inherit; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
[data-theme-part="app-header"] { background: hsl(var(--card)); border-bottom: 2px solid hsl(75 35% 12% / .85); }
[data-theme-part="progress-indicator"] { background-image: none; background-color: hsl(75 35% 14%); }
${STATE_DETAILS}
${FOCUS_RING}
`

export const WASHI_CSS = `/* WASHI · Kozo paper fibers, deckle edges and a vermillion hanko seal. */
[data-theme-part="app-shell"] {
  background-color: hsl(var(--background));
  background-image: repeating-linear-gradient(84deg, hsl(35 45% 55% / .09) 0 2px, transparent 2px 7px),
    radial-gradient(ellipse at 20% 0%, hsl(0 0% 100% / .5), transparent 60%);
}
${SURFACES} {
  border: 1px solid hsl(20 30% 40% / .26); border-radius: 6px 3px 7px 4px;
  box-shadow: 0 2px 6px hsl(20 30% 30% / .1), inset 0 1px 0 hsl(0 0% 100% / .6);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card) / .92); }
${ACTIONS}, ${FIELDS} { border: 1px solid hsl(20 30% 40% / .32); border-radius: 5px 3px 5px 3px; }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground);
}
:is([data-theme-part="nav-item"], [data-theme-part="tab"]):is([data-state="active"], [aria-current="page"]) {
  background: transparent; color: hsl(var(--primary)); box-shadow: inset 0 -2px 0 hsl(var(--primary) / .8);
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(355 45% 42% / .1); }
${TOGGLES}, ${ITEMS} { border-radius: 4px; }
[data-theme-part="badge"] { border: 1.5px solid hsl(var(--primary) / .85); border-radius: 2px; }
[data-theme-part="app-header"] { background: hsl(var(--card) / .95); border-bottom: 2px solid hsl(355 45% 42% / .5); }
${STATE_DETAILS}
${FOCUS_RING}
`

export const CLAY_STUDIO_CSS = `/* CLAY STUDIO · Speckled artisan glaze over organic hand-thrown silhouettes. */
[data-theme-part="app-shell"] {
  background-color: hsl(var(--background));
  background-image: radial-gradient(hsl(16 40% 30% / .08) 1px, transparent 1.4px), radial-gradient(hsl(16 45% 45% / .06) 1px, transparent 1.4px);
  background-size: 17px 17px, 29px 29px; background-position: 0 0, 9px 13px;
}
${SURFACES} {
  border: 1px solid hsl(16 45% 45% / .3); border-radius: 20px 12px 22px 14px;
  box-shadow: inset 0 1px 0 hsl(0 0% 100% / .55), 0 4px 12px hsl(16 40% 25% / .14);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card)); }
${ACTIONS} { border: 1px solid hsl(16 45% 45% / .35); border-radius: 14px 9px 14px 9px; }
${FIELDS} { border: 1px solid hsl(16 45% 45% / .35); border-radius: 12px; background: hsl(28 40% 99%); box-shadow: inset 0 2px 4px hsl(16 40% 30% / .14); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground);
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(16 60% 40% / .12); }
${TOGGLES}, ${ITEMS} { border-radius: 999px; }
[data-theme-part="badge"] { border-radius: 999px; border: 1px solid hsl(16 45% 45% / .4); }
h1, h2, h3 { letter-spacing: .01em; }
[data-theme-part="app-header"] { background: hsl(var(--card)); border-bottom: 1px solid hsl(16 45% 45% / .35); border-radius: 0 0 18px 18px; }
${STATE_DETAILS}
${FOCUS_RING}
`

export const DENIM_CSS = `/* DENIM · Indigo twill weave with golden contrast stitching and brass buttons. */
:root { --denim-thread: hsl(38 85% 52%); }
[data-theme-part="app-shell"] {
  background-color: hsl(var(--background));
  background-image: repeating-linear-gradient(45deg, hsl(222 45% 25% / .12) 0 2px, transparent 2px 6px);
}
${SURFACES} {
  border: 2px dashed var(--denim-thread); border-radius: 10px;
  box-shadow: 0 3px 8px hsl(222 45% 20% / .22), inset 0 1px 0 hsl(0 0% 100% / .35);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card)); }
${ACTIONS} { border: 2px dashed hsl(38 85% 45% / .8); border-radius: 8px; }
${FIELDS} { border: 2px solid hsl(222 50% 28% / .8); border-radius: 8px; background: hsl(220 35% 96%); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground);
  border-style: solid;
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(222 55% 32% / .12); box-shadow: inset 3px 0 0 var(--denim-thread); }
${TOGGLES}, ${ITEMS} { border-radius: 6px; }
[data-theme-part="badge"] { border: 1.5px dashed hsl(38 85% 40% / .9); border-radius: 999px; }
[data-theme-part="app-header"] { background: hsl(var(--card)); border-bottom: 2px dashed hsl(38 85% 50% / .7); }
${STATE_DETAILS}
${FOCUS_RING}
`

export const ARCTIC_GLASS_CSS = `/* ARCTIC GLASS · Frosted panes over an ice-sky gradient; nav opts back into blur. */
[data-theme-part="app-shell"] {
  isolation: isolate;
  background-color: hsl(var(--background));
  background-image: linear-gradient(160deg, hsl(205 70% 95%), hsl(198 50% 89%) 55%, hsl(195 60% 91%));
}
[data-theme-part="app-nav"] { --theme-nav-backdrop: blur(12px) saturate(130%); }
${SURFACES} {
  border: 1px solid hsl(0 0% 100% / .85); border-radius: 14px;
  background-color: hsl(var(--card) / .62);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  box-shadow: 0 6px 18px hsl(205 60% 40% / .16), inset 0 1px 0 hsl(0 0% 100% / .8);
}
[data-theme-part="menu"], [data-theme-part="popover"], [data-theme-part="select-content"], [data-theme-part="tooltip"], [data-theme-part="toast"] { background-color: hsl(var(--card) / .94); }
${ACTIONS} {
  border: 1px solid hsl(0 0% 100% / .9); border-radius: 10px;
  background-color: hsl(0 0% 100% / .55); box-shadow: 0 2px 6px hsl(205 60% 40% / .12);
}
${FIELDS} { border: 1px solid hsl(0 0% 100% / .9); border-radius: 10px; background: hsl(0 0% 100% / .8); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground);
  border-color: hsl(var(--primary));
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(203 70% 38% / .12); }
${TOGGLES}, ${ITEMS} { border-radius: 8px; }
[data-theme-part="badge"] { border-radius: 999px; border: 1px solid hsl(0 0% 100% / .9); background: hsl(0 0% 100% / .5); }
[data-theme-part="app-header"] { background: hsl(205 60% 92% / .8); border-bottom: 1px solid hsl(0 0% 100% / .9); }
${STATE_DETAILS}
${FOCUS_RING}
`

export const SHERBET_CSS = `/* SHERBET · Sorbet tri-gradient, generous rounding and candy-glow shadows. */
[data-theme-part="app-shell"] {
  isolation: isolate;
  background-color: hsl(var(--background));
  background-image: linear-gradient(120deg, hsl(18 80% 94%), hsl(160 55% 94%) 50%, hsl(280 60% 95%));
}
${SURFACES} {
  border: 1px solid hsl(280 40% 82% / .9); border-radius: 16px;
  box-shadow: 0 6px 16px hsl(280 50% 60% / .16), inset 0 1px 0 hsl(0 0% 100% / .8);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card) / .9); }
${ACTIONS}, ${FIELDS} { border: 1px solid hsl(280 35% 80%); border-radius: 12px; }
${FIELDS} { background: hsl(0 0% 100% / .85); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: linear-gradient(135deg, hsl(330 60% 52%), hsl(280 60% 58%)); color: hsl(0 0% 100%);
  --foreground: 0 0% 100%; --muted-foreground: 0 0% 100%;
  box-shadow: 0 4px 12px hsl(310 60% 55% / .3);
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(160 50% 60% / .18); }
${TOGGLES}, ${ITEMS} { border-radius: 10px; }
[data-theme-part="badge"] { border-radius: 999px; border: 1px solid hsl(280 35% 78%); }
[data-theme-part="app-header"] { background: hsl(30 55% 98% / .92); border-bottom: 1px solid hsl(280 35% 84%); }
${STATE_DETAILS}
${FOCUS_RING}
`

export const COTTAGE_CSS = `/* COTTAGE · Gingham tablecloth checks, cream china cards and rose trim. */
[data-theme-part="app-shell"] {
  isolation: isolate;
  background-color: hsl(var(--background));
  background-image:
    repeating-linear-gradient(0deg, hsl(345 65% 55% / .1) 0 12px, transparent 12px 24px),
    repeating-linear-gradient(90deg, hsl(345 65% 55% / .1) 0 12px, transparent 12px 24px);
}
${SURFACES} {
  border: 1px solid hsl(10 35% 60% / .4); border-radius: 12px;
  box-shadow: 0 3px 10px hsl(10 40% 40% / .14), inset 0 1px 0 hsl(0 0% 100% / .7);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card)); }
${ACTIONS}, ${FIELDS} { border: 1px solid hsl(10 35% 55% / .45); border-radius: 9px; }
${FIELDS} { background: hsl(40 45% 99%); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground);
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(345 55% 40% / .12); }
${TOGGLES}, ${ITEMS} { border-radius: 8px; }
[data-theme-part="badge"] { border-radius: 999px; border: 1px dashed hsl(345 55% 45% / .7); }
[data-theme-part="app-header"] { background: hsl(var(--card)); border-bottom: 2px dashed hsl(345 55% 50% / .5); }
${STATE_DETAILS}
${FOCUS_RING}
`

export const ZEN_GARDEN_CSS = `/* ZEN GARDEN · Raked sand lines, pebble controls and a calm moss accent. */
[data-theme-part="app-shell"] {
  isolation: isolate;
  background-color: hsl(var(--background));
  background-image: repeating-linear-gradient(90deg, hsl(45 25% 55% / .14) 0 2px, transparent 2px 18px),
    repeating-linear-gradient(90deg, hsl(45 25% 55% / .1) 0 2px, transparent 2px 46px);
}
${SURFACES} {
  border: 1px solid hsl(45 18% 52% / .4); border-radius: 14px;
  box-shadow: 0 4px 14px hsl(45 20% 40% / .1);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card)); }
${ACTIONS}, ${FIELDS} { border: 1px solid hsl(45 18% 50% / .5); border-radius: 10px; }
${FIELDS} { background: hsl(45 30% 99%); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground);
}
:is([data-theme-part="nav-item"], [data-theme-part="tab"]):is([data-state="active"], [aria-current="page"]) {
  background: transparent; color: hsl(var(--primary)); box-shadow: inset 0 -2px 0 hsl(var(--primary) / .75);
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(130 30% 30% / .1); }
${TOGGLES}, ${ITEMS} { border-radius: 999px; }
[data-theme-part="badge"] { border-radius: 999px; border: 1px solid hsl(45 18% 50% / .55); }
[data-theme-part="app-header"] { background: hsl(var(--card)); border-bottom: 1px solid hsl(45 18% 55% / .5); }
${STATE_DETAILS}
${FOCUS_RING}
`

export const ORIGAMI_CSS = `/* ORIGAMI · Creased paper gradient with folded-corner cards and crisp edges. */
[data-theme-part="app-shell"] {
  isolation: isolate;
  background-color: hsl(var(--background));
  background-image: linear-gradient(115deg, hsl(220 35% 96%), hsl(220 22% 93%) 30%, hsl(220 35% 96%) 50%, hsl(35 70% 92%) 76%, hsl(220 30% 95%));
}
${SURFACES} {
  position: relative; border: 1px solid hsl(225 30% 58% / .5); border-radius: 3px;
  box-shadow: 2px 3px 0 hsl(225 35% 35% / .14);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card)); }
/* A folded dog-ear corner; decorative only and never intercepts pointers. */
:is([data-theme-part="card"], [data-theme-part="addon-card"], [data-theme-part="panel"])::after {
  content: ''; position: absolute; top: 0; right: 0; width: 15px; height: 15px; pointer-events: none;
  background: linear-gradient(225deg, hsl(0 0% 100% / .95) 50%, hsl(225 40% 70% / .6) 50%);
  border-start-end-radius: 2px;
  box-shadow: -2px 2px 3px hsl(225 40% 40% / .18);
}
${ACTIONS}, ${FIELDS} { border: 1px solid hsl(225 30% 55% / .6); border-radius: 3px; }
${FIELDS} { background: hsl(0 0% 100%); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground);
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(34 80% 46% / .12); box-shadow: inset 3px 0 0 hsl(var(--primary) / .8); }
${TOGGLES}, ${ITEMS} { border-radius: 2px; }
[data-theme-part="badge"] { border: 1px solid hsl(225 30% 55% / .65); border-radius: 2px; }
[data-theme-part="app-header"] { background: hsl(var(--card)); border-bottom: 1px solid hsl(225 30% 60% / .55); }
${STATE_DETAILS}
${FOCUS_RING}
`

export const SONAR_CSS = `/* SONAR · Range rings and a slow sweep wedge over the abyssal plain. */
body { font-family: 'Segoe UI', system-ui, sans-serif; }
[data-theme-part="app-shell"] {
  isolation: isolate;
  background-color: hsl(var(--background));
  background-image: repeating-radial-gradient(circle at 50% 28%, hsl(175 80% 55% / .05) 0 1px, transparent 1px 56px);
}
/* The sweep stays oversized so rotation never reveals its edges. */
[data-theme-part="app-shell"]::before {
  content: ''; position: fixed; inset: -60%; z-index: -1; pointer-events: none;
  background: conic-gradient(from 0deg at 50% 42.5%, hsl(175 90% 60% / .14), transparent 70deg);
}
${SURFACES} {
  border: 1px solid hsl(175 75% 50% / .4); border-radius: 6px;
  box-shadow: inset 0 0 18px hsl(175 85% 55% / .05), 0 4px 14px hsl(215 80% 3% / .6);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card) / .94); }
${ACTIONS}, ${FIELDS} { border: 1px solid hsl(175 75% 50% / .48); border-radius: 4px; font-family: inherit; }
${FIELDS} { background-color: hsl(215 60% 5%); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground);
  box-shadow: 0 0 16px hsl(175 85% 55% / .3);
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(175 85% 55% / .13); }
${TOGGLES}, ${ITEMS}, [data-theme-part="badge"] { border-radius: 3px; }
[data-theme-part="badge"] { border: 1px solid hsl(175 85% 60% / .6); font-family: ui-monospace, Consolas, monospace; }
h1, h2, h3 { letter-spacing: .06em; }
[data-theme-part="app-header"] { background: hsl(215 60% 6% / .97); border-bottom: 1px solid hsl(175 85% 55% / .5); }
${STATE_DETAILS}
${FOCUS_RING}
@media (prefers-reduced-motion: no-preference) {
  [data-theme-part="app-shell"]::before { animation: sonar-sweep 12s linear infinite; }
}
@keyframes sonar-sweep { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`

export const LAVA_LAMP_CSS = `/* LAVA LAMP · Two morphing wax blobs behind smoked-plum glass. */
:root { --fx-duration: 19s; }
[data-theme-part="app-shell"] {
  isolation: isolate;
  background-color: hsl(var(--background));
  background-image: linear-gradient(180deg, hsl(280 40% 10%), hsl(290 35% 6%));
}
/* Blurred wax never touches the interface layer. */
[data-theme-part="app-shell"]::before, [data-theme-part="app-shell"]::after {
  content: ''; position: fixed; z-index: -1; pointer-events: none;
  width: 44vmin; height: 52vmin; opacity: .5; filter: blur(42px);
}
/* Blob silhouettes differ statically; motion is compositor-only (rotate/scale
   wobble reads as the same morph without re-rasterizing the blurred layer). */
[data-theme-part="app-shell"]::before {
  left: 8%; bottom: -12vmin; background: linear-gradient(hsl(315 90% 60% / .8), hsl(20 95% 55% / .7));
  border-radius: 42% 58% 55% 45% / 55% 45% 60% 40%;
}
[data-theme-part="app-shell"]::after {
  right: 6%; top: 6%; background: linear-gradient(hsl(25 95% 58% / .7), hsl(340 90% 62% / .65));
  border-radius: 55% 45% 48% 52% / 45% 58% 42% 55%;
}
${SURFACES} {
  border: 1px solid hsl(315 60% 66% / .35); border-radius: 18px;
  box-shadow: inset 0 1px 0 hsl(0 0% 100% / .1), 0 6px 18px hsl(280 60% 3% / .55);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card) / .82); }
${ACTIONS}, ${FIELDS} { border: 1px solid hsl(315 60% 66% / .42); border-radius: 999px; }
${FIELDS} { background-color: hsl(280 35% 8%); color: hsl(310 30% 95%); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: linear-gradient(135deg, hsl(315 90% 65%), hsl(25 95% 58%)); color: hsl(280 40% 8%);
  --foreground: 280 40% 8%; --muted-foreground: 280 30% 20%;
  box-shadow: 0 0 18px hsl(315 90% 60% / .3);
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(315 90% 65% / .13); }
${TOGGLES}, ${ITEMS} { border-radius: 999px; }
[data-theme-part="badge"] { border: 1px solid hsl(315 80% 72% / .55); border-radius: 999px; }
[data-theme-part="app-header"] { background: hsl(280 35% 9% / .95); border-bottom: 1px solid hsl(315 70% 60% / .45); }
${STATE_DETAILS}
${FOCUS_RING}
@media (prefers-reduced-motion: no-preference) {
  [data-theme-part="app-shell"]::before { animation: lava-rise var(--fx-duration, 19s) ease-in-out infinite alternate; }
  [data-theme-part="app-shell"]::after { animation: lava-sway calc(var(--fx-duration, 19s) * 1.2) ease-in-out infinite alternate; }
}
@keyframes lava-rise {
  from { transform: translate(0, 6vmin) scale(1) rotate(0deg); }
  to { transform: translate(4vmin, -8vmin) scale(1.15) rotate(26deg); }
}
@keyframes lava-sway {
  from { transform: translate(0, 0) scale(1) rotate(0deg); }
  to { transform: translate(-5vmin, 5vmin) scale(.9) rotate(-22deg); }
}
`
