// These styles deliberately use theme parts rather than a preset ID so a clone
// keeps its full appearance. The comments travel with exported custom themes.
// Inset controls belong to one larger surface; their utility geometry stays intact.
const parts = (...names: string[]) => `:is(${names.map(name => `[data-theme-part="${name}"]`).join(', ')}):where(:not([data-theme-inset]))`
const SURFACES = parts('card', 'addon-card', 'panel', 'toolbar', 'app-nav', 'mobile-nav', 'mobile-status', 'app-footer', 'footer-nav', 'header-status', 'tabs-list', 'dialog', 'menu', 'popover', 'select-content', 'tooltip', 'toast')
// Status panels keep their semantic fill while receiving the skin's frame.
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

const AMBIENT_CONTROLS = `
${ACTIONS}, ${FIELDS} { border-radius: 9px; }
${IMAGE_PARTS} { border-radius: 9px; }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: hsl(var(--primary) / .17);
  box-shadow: inset 0 -2px 0 hsl(var(--primary));
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(var(--primary) / .12); }
${STATE_DETAILS}
:is(button, input, textarea, select, a):focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 3px; }
`

// A small repeating SVG is part of the CSS itself, so exports need no asset files.
const MATRIX_GLYPHS = '01ZX7539A82K4'
const matrixRainImage = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="336" height="480" viewBox="0 0 336 480"><g font-family="monospace" font-size="15" font-weight="600">${Array.from({ length: 12 }, (_, column) => {
    const x = 10 + column * 28
    const length = 10 + column % 5
    const head = ((column * 7 + 9) % 24) * 20 + 16
    return Array.from({ length }, (_, row) => {
        const y = (head - (length - 1 - row) * 20 + 480) % 480
        const glyph = MATRIX_GLYPHS[(row * 3 + column * 5) % MATRIX_GLYPHS.length]
        return `<text x="${x}" y="${y}" fill="${row === length - 1 ? '#d9ffe7' : '#38ff94'}" opacity="${(.1 + row / (length - 1) * .9).toFixed(2)}">${glyph}</text>`
    }).join('')
}).join('')}</g></svg>`)}")`

export const MATRIX_RAIN_CSS = `/* MATRIX RAIN · Embedded glyph trails, bright heads and two independent fall speeds. */
body { font-family: ui-monospace, Consolas, monospace; }
[data-theme-part="app-shell"] {
  isolation: isolate;
  background-color: hsl(var(--background));
  background-image: radial-gradient(ellipse at 50% 20%, hsl(var(--primary) / .06), transparent 70%);
}
/* Viewport-sized layers stay behind the UI and never intercept clicks.
   Moving one whole tile with transform gives a seamless, composited loop. */
[data-theme-part="app-shell"]::before, [data-theme-part="app-shell"]::after {
  content: ''; position: fixed; pointer-events: none; z-index: -1;
  background-image: ${matrixRainImage}; background-repeat: repeat;
}
[data-theme-part="app-shell"]::before {
  inset: -480px 0 0; background-size: 336px 480px; opacity: .6;
}
[data-theme-part="app-shell"]::after {
  inset: -720px 0 0; background-size: 504px 720px;
  background-position: 168px 240px; opacity: .24;
}
${SURFACES} { border: 1px solid hsl(var(--primary) / .3); border-radius: 3px; box-shadow: inset 0 1px 0 hsl(var(--primary) / .08); }
${PAINTED_SURFACES} { background-color: hsl(var(--card) / .94); }
${ACTIONS}, ${FIELDS} { border: 1px solid hsl(var(--primary) / .28); border-radius: 2px; font-family: inherit; }
${FIELDS} { background-color: hsl(var(--background) / .85); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background-color: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground);
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(var(--primary) / .15); }
${TOGGLES}, ${ITEMS}, [data-theme-part="badge"] { border-radius: 2px; }
[data-theme-part="app-header"] { background: hsl(var(--card) / .97); border-bottom: 1px solid hsl(var(--primary) / .5); }
h1, h2, h3 { font-family: inherit; text-shadow: 0 0 18px hsl(var(--primary) / .25); }
${STATE_DETAILS}
:is(button, input, textarea, select, a):focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 3px; }
@media (prefers-reduced-motion: no-preference) {
  [data-theme-part="app-shell"]::before { animation: matrix-rain-near 5s linear infinite; }
  [data-theme-part="app-shell"]::after { animation: matrix-rain-far 11s linear infinite; }
}
@keyframes matrix-rain-near { from { transform: translateY(0); } to { transform: translateY(480px); } }
@keyframes matrix-rain-far { from { transform: translateY(0); } to { transform: translateY(720px); } }
`

export const PIP_BOY_CSS = `/* PIP-BOY · Fallout-inspired phosphor, instrument frames and a slow CRT sweep. */
body { font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; }
[data-theme-part="app-shell"] {
  isolation: isolate;
  background-image: repeating-linear-gradient(0deg, transparent 0 3px, hsl(var(--primary) / .045) 3px 4px), radial-gradient(ellipse at 50% 35%, hsl(var(--primary) / .07), transparent 75%);
}
/* Decorative light stays behind every control and never blocks the interface. */
[data-theme-part="app-shell"]::before {
  content: ''; position: fixed; top: -12vh; left: 0; right: 0; height: 12vh;
  z-index: -1; pointer-events: none;
  background: linear-gradient(transparent, hsl(var(--primary) / .055), transparent);
}
${SURFACES} {
  border: 1px solid hsl(var(--primary) / .5); border-radius: 2px;
  box-shadow: inset 0 0 24px hsl(var(--primary) / .035), 0 0 12px hsl(var(--primary) / .06);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card) / .96); }
${parts('card', 'addon-card', 'panel', 'dialog')} {
  box-shadow: inset 0 0 0 3px hsl(var(--background)), inset 0 0 0 4px hsl(var(--primary) / .25), 0 0 14px hsl(var(--primary) / .07);
}
${ACTIONS}, ${FIELDS} {
  border: 1px solid hsl(var(--primary) / .45); border-radius: 1px; font-family: inherit;
}
${FIELDS} { background-color: hsl(var(--background) / .85); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground);
  box-shadow: 0 0 14px hsl(var(--primary) / .18);
}
${ITEMS} { border-radius: 1px; }
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(var(--primary) / .14); box-shadow: inset 3px 0 hsl(var(--primary)); }
${TOGGLES}, [data-theme-part="badge"] { border-radius: 1px; }
[data-theme-part="badge"] { border: 1px solid currentColor; font-family: inherit; }
[data-theme-part="app-header"] { background: hsl(var(--card) / .97); border-bottom: 2px solid hsl(var(--primary) / .65); }
h1, h2, h3 { font-family: inherit; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; text-shadow: 0 0 12px hsl(var(--primary) / .3); }
${parts('nav-item', 'tab')} { text-transform: uppercase; letter-spacing: .025em; }
${STATE_DETAILS}
:is(button, input, textarea, select, a):focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 3px; }
@media (prefers-reduced-motion: no-preference) {
  [data-theme-part="app-shell"]::before { animation: pip-boy-sweep 9s linear infinite; }
}
@keyframes pip-boy-sweep { from { transform: translateY(0); } to { transform: translateY(112vh); } }
`


export const NEON_ARCADE_CSS = `/* NEON ARCADE · Moving cyan grid, hot-pink selections and neon cabinet frames. */
body { font-family: 'Trebuchet MS', system-ui, sans-serif; }
[data-theme-part="app-shell"] {
  isolation: isolate;
  background-color: hsl(var(--background));
  background-image: radial-gradient(ellipse at 50% 0%, hsl(318 100% 60% / .18), transparent 65%);
}
[data-theme-part="app-shell"]::before {
  content: ''; position: fixed; inset: -48px 0 0; z-index: -1; pointer-events: none;
  background-image: linear-gradient(hsl(188 100% 60% / .12) 1px, transparent 1px), linear-gradient(90deg, hsl(188 100% 60% / .12) 1px, transparent 1px);
  background-size: 48px 48px;
}
${SURFACES} { border: 1px solid hsl(188 100% 65% / .45); border-radius: 5px; box-shadow: 3px 3px 0 hsl(var(--primary) / .35), 0 0 20px hsl(188 100% 60% / .04); }
${PAINTED_SURFACES} { background-color: hsl(var(--card) / .95); }
${ACTIONS}, ${FIELDS} { border: 1px solid hsl(188 100% 65% / .4); border-radius: 3px; }
${FIELDS} { background-color: hsl(var(--background) / .8); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background-color: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground);
  box-shadow: 0 0 16px hsl(var(--primary) / .22);
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(var(--primary) / .15); }
${TOGGLES}, ${ITEMS}, [data-theme-part="badge"] { border-radius: 3px; }
[data-theme-part="app-header"] { background: hsl(var(--card)); border-bottom: 1px solid hsl(188 100% 65% / .6); box-shadow: 0 4px 20px hsl(var(--primary) / .14); }
h1, h2, h3 { letter-spacing: .025em; text-shadow: 2px 2px 0 hsl(var(--primary) / .3); }
${STATE_DETAILS}
:is(button, input, textarea, select, a):focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 3px; }
@media (prefers-reduced-motion: no-preference) {
  [data-theme-part="app-shell"]::before { animation: neon-arcade-grid 6s linear infinite; }
}
@keyframes neon-arcade-grid {
  from { transform: translateY(0); }
  to { transform: translateY(48px); }
}
`

export const BLUEPRINT_LIVE_CSS = `/* BLUEPRINT LIVE · The header responds to the app's published sync state. */
body { font-family: ui-monospace, Consolas, monospace; }
[data-theme-part="app-shell"] {
  background-color: hsl(var(--background));
  background-image: linear-gradient(hsl(var(--primary) / .08) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--primary) / .08) 1px, transparent 1px);
  background-size: 24px 24px;
}
${SURFACES} { border: 1px solid hsl(var(--primary) / .4); border-radius: 3px; box-shadow: 4px 4px 0 hsl(var(--primary) / .06); }
${PAINTED_SURFACES} { background-color: hsl(var(--card) / .95); }
${AMBIENT_CONTROLS}
${ACTIONS}, ${FIELDS}, ${TOGGLES}, ${ITEMS}, [data-theme-part="badge"] { border-radius: 2px; }
${ACTIONS} { border: 1px solid hsl(var(--primary) / .4); }
[data-theme-part="app-header"] { position: relative; background: hsl(var(--card)); border-bottom: 1px solid hsl(var(--primary) / .5); }
/* This observes syncing; it never starts a sync or runs theme scripts. */
@supports selector(:has(*)) {
  [data-theme-part="app-shell"]:has([data-sync-state="syncing"]) [data-theme-part="app-header"] { box-shadow: 0 0 28px hsl(var(--primary) / .5); }
  [data-theme-part="app-shell"]:has([data-sync-state="syncing"]) [data-theme-part="app-header"]::after {
    content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px; pointer-events: none;
    background: linear-gradient(90deg, transparent, hsl(var(--primary)), transparent); background-size: 200% 100%;
  }
  @media (prefers-reduced-motion: no-preference) {
    [data-theme-part="app-shell"]:has([data-sync-state="syncing"]) [data-theme-part="app-header"]::after { animation: blueprint-live-scan 2s linear infinite; }
  }
}
@keyframes blueprint-live-scan { from { background-position: 200% 0; } to { background-position: 0 0; } }
`

export const LIQUID_CHROME_CSS = `/* LIQUID CHROME · Brushed metal, violet selections and a slow title-bar sheen. */
body { font-family: 'Segoe UI', system-ui, sans-serif; }
[data-theme-part="app-shell"] { background-image: linear-gradient(125deg, hsl(220 20% 96%), hsl(218 16% 82%) 45%, hsl(250 25% 91%)); }
${SURFACES} {
  border: 1px solid hsl(218 12% 62%); border-radius: 16px;
  box-shadow: inset 0 1px 0 white, 0 6px 18px hsl(220 20% 30% / .14);
}
${PAINTED_SURFACES} { background: linear-gradient(145deg, hsl(0 0% 100% / .96), hsl(218 15% 89% / .96)); }
${AMBIENT_CONTROLS}
${ACTIONS} { border: 1px solid hsl(218 12% 62%); box-shadow: inset 0 1px 0 hsl(0 0% 100% / .7), 0 1px 2px hsl(220 20% 20% / .1); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground); }
${FIELDS} { background: hsl(0 0% 100%); box-shadow: inset 0 1px 3px hsl(220 20% 20% / .12); }
[data-theme-part="app-header"] {
  background: linear-gradient(110deg, hsl(218 14% 88%) 10%, white 30%, hsl(218 10% 70%) 55%, white 75%, hsl(218 15% 88%) 95%);
  background-size: 220% 100%; border-bottom: 1px solid hsl(218 12% 60%);
}
@media (prefers-reduced-motion: no-preference) {
  [data-theme-part="app-header"] { animation: liquid-chrome-sheen 9s ease-in-out infinite alternate; }
}
@keyframes liquid-chrome-sheen { from { background-position: 0% 0; } to { background-position: 100% 0; } }
`

export const COMIC_BOOK_CLASSIC_CSS = `/* COMIC BOOK · Solid ink frames and offset shadows. */
${SURFACES} { border: 2px solid hsl(0 0% 10%); border-radius: 4px; box-shadow: 3px 3px 0 hsl(0 0% 10%); }
${PAINTED_SURFACES} { background-color: hsl(var(--card)); }
${ACTIONS} { border: 2px solid hsl(0 0% 10%); border-radius: 4px; box-shadow: 2px 2px 0 hsl(0 0% 10%); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground);
}
${FIELDS} { border: 2px solid hsl(0 0% 10%); border-radius: 2px; }
${TOGGLES}, ${ITEMS}, [data-theme-part="badge"] { border-radius: 2px; }
[data-theme-part="badge"] { border: 1px solid currentColor; }
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(var(--primary) / .12); }
${STATE_DETAILS}
:is(button, input, textarea, select, a):focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 3px; }
`

export const COMIC_BOOK_CSS = `/* COMIC BOOK+ · Change the ink, dot spacing and shadow offset to remix. */
:root { --comic-ink: hsl(225 30% 12%); }
body { font-family: 'Trebuchet MS', system-ui, sans-serif; }
[data-theme-part="app-shell"] {
  background-image: radial-gradient(hsl(var(--primary) / .22) .8px, transparent 1px);
  background-size: 8px 8px;
}
/* Shared surfaces include navigation, toolbars, menus and dialogs. */
${SURFACES} {
  border: 2px solid var(--comic-ink);
  border-radius: 6px;
  box-shadow: 4px 4px 0 var(--comic-ink);
}
${ACTIONS}, ${FIELDS} {
  border: 2px solid var(--comic-ink);
  border-radius: 5px;
}
${ACTIONS} { box-shadow: 2px 2px 0 var(--comic-ink); }
${ACTIONS}:active { box-shadow: none; translate: 2px 2px; }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground);
  --muted-foreground: var(--primary-foreground);
  box-shadow: none;
}
${ITEMS} { border-radius: 3px; }
${ITEMS}:is(:hover, [data-highlighted]) { box-shadow: inset 3px 0 0 var(--comic-ink); }
${TOGGLES} { border-radius: 3px; }
[data-theme-part="badge"] { border: 1.5px solid currentColor; border-radius: 4px; }
h1, h2, h3 { font-weight: 900; letter-spacing: -.035em; }
[data-theme-part="app-header"] { border-bottom: 2px solid var(--comic-ink); }
${STATE_DETAILS}
/* Keep focus indicators visible when adding your own hover/pressed effects. */
:is(button, input, textarea, a):focus-visible { outline: 3px solid hsl(var(--ring)); outline-offset: 3px; }
`

export const RETRO_DESKTOP_CSS = `/* RETRO DESKTOP · Bevels, title bars, system fonts and a teal desktop. */
body { font-family: Tahoma, Verdana, system-ui, sans-serif; }
[data-theme-part="app-shell"] {
  background-image: linear-gradient(135deg, hsl(180 42% 25% / .16) 25%, transparent 25%, transparent 75%, hsl(180 42% 25% / .16) 75%);
  background-size: 4px 4px;
}
/* Inset shadows create a bevel without changing the layout or hit targets. */
${SURFACES} {
  border: 1px solid hsl(0 0% 24%);
  border-radius: 2px;
  box-shadow: inset 2px 2px 0 hsl(0 0% 100%), inset -2px -2px 0 hsl(0 0% 48%), 4px 4px 0 hsl(0 0% 0% / .18);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card)); }
${ACTIONS} {
  border-radius: 2px;
  border: 1px solid hsl(0 0% 30%);
  box-shadow: inset 1px 1px 0 hsl(0 0% 100% / .8), inset -1px -1px 0 hsl(0 0% 0% / .35);
}
${ACTIONS}:active { box-shadow: inset 1px 1px 0 hsl(0 0% 0% / .4); }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  --foreground: var(--primary-foreground);
  --muted-foreground: var(--primary-foreground);
  box-shadow: inset 1px 1px 0 hsl(0 0% 0% / .45);
}
${FIELDS} {
  border-radius: 1px;
  background: hsl(0 0% 100%);
  color: hsl(0 0% 10%);
  box-shadow: inset 1px 1px 0 hsl(0 0% 0% / .45);
}
[data-theme-part="badge"] { border-radius: 2px; }
${TOGGLES}, ${ITEMS} { border-radius: 1px; }
${ITEMS}:not([data-variant="destructive"]):is(:hover, [data-highlighted]) {
  background-color: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
}
[data-theme-part="app-header"] {
  --foreground: 0 0% 100%;
  --muted-foreground: 0 0% 90%;
  background: linear-gradient(90deg, hsl(232 68% 28%), hsl(210 65% 45%));
  color: white;
}
[data-theme-part="app-header"] :is(input, button, [data-theme-part="avatar"]), [data-theme-part="header-status"] {
  --foreground: 225 20% 12%;
  --muted-foreground: 225 10% 30%;
  color: hsl(var(--foreground));
  background-color: hsl(var(--card));
}
h1, h2, h3 { font-family: Tahoma, Verdana, sans-serif; letter-spacing: 0; }
${STATE_DETAILS}
`

export const CRT_TERMINAL_CSS = `/* CRT TERMINAL · Static scanlines keep the phosphor look without flashing. */
body { font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; }
[data-theme-part="app-shell"] {
  background-image: repeating-linear-gradient(0deg, transparent 0 3px, hsl(142 80% 65% / .045) 3px 4px);
}
${SURFACES} {
  border: 1px solid hsl(var(--primary) / .45);
  border-radius: 3px;
  box-shadow: inset 0 0 24px hsl(var(--primary) / .025), 0 0 18px hsl(var(--primary) / .07);
}
${PAINTED_SURFACES} { background-color: hsl(var(--card)); }
${ACTIONS}, ${FIELDS} {
  border-radius: 2px;
  border: 1px solid hsl(var(--primary) / .5);
  font-family: inherit;
}
[data-theme-part="badge"] { border-radius: 2px; font-family: inherit; }
${TOGGLES}, ${ITEMS} { border-radius: 2px; }
${ACTIONS}:is([data-state="active"], [aria-current="page"], [aria-pressed="true"], [aria-selected="true"]) {
  background-color: hsl(var(--primary) / .17);
  color: hsl(var(--primary));
  box-shadow: inset 0 -2px 0 hsl(var(--primary));
}
${ITEMS}:is(:hover, [data-highlighted]) { background-color: hsl(var(--primary) / .12); }
h1, h2, h3 { font-family: inherit; text-shadow: 0 0 12px hsl(var(--primary) / .35); }
/* Animate glow, never layout. Respect the reader's reduced-motion setting. */
@media (prefers-reduced-motion: no-preference) {
  h1 { animation: aioman-phosphor 6s ease-in-out infinite alternate; }
}
@keyframes aioman-phosphor {
  from { text-shadow: 0 0 8px hsl(var(--primary) / .2); }
  to { text-shadow: 0 0 16px hsl(var(--primary) / .5); }
}
[data-theme-part="app-header"] { border-bottom: 1px solid hsl(var(--primary) / .4); }
${STATE_DETAILS}
`
