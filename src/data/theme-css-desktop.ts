// DESKTOP / OS-INSPIRED THEMES · 2026-10 · user-approved set
// Modern Windows homage, synthesized purely in CSS on
// the app's data-theme-part tree: titlebar-like headers, taskbar-like nav,
// window-edge cards, era-correct type and selected states. Inspired-by, not
// pixel clones: no OS assets, no glyph-emoji chrome, every decoration is an
// inert pseudo-element (pointer-events: none) so real actions stay clickable
// and focus stays visible. Mostly static by design; any motion is guarded.
const parts = (...names: string[]) => `:is(${names.map(name => `[data-theme-part="${name}"]`).join(', ')}):where(:not([data-theme-inset]))`
const SURFACES = parts('card', 'addon-card', 'panel', 'toolbar', 'app-nav', 'mobile-nav', 'mobile-status', 'app-footer', 'footer-nav', 'header-status', 'tabs-list', 'dialog', 'menu', 'popover', 'select-content', 'tooltip', 'toast')
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
const FOCUS_RING = `:is(button, input, textarea, select, a):focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }`

export const WIN_MODERN_CSS = `/* MODERN WINDOWS · Calm mica light: soft rounding, hairline edges, accent bar. */
body { font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif; }
[data-theme-part="app-shell"] {
  background-color: hsl(var(--background));
  background-image: radial-gradient(ellipse at 18% 0%, hsl(205 60% 92%), transparent 55%), radial-gradient(ellipse at 90% 100%, hsl(260 40% 92%), transparent 50%);
}
/* Mica layers: near-solid planes, hairline borders, soft depth. */
${SURFACES} {
  background: hsl(var(--card) / .92); border: 1px solid hsl(var(--border)); border-radius: 8px;
  box-shadow: 0 2px 6px hsl(222 30% 30% / .08), 0 8px 24px hsl(222 30% 30% / .06);
}
[data-theme-part="app-header"] {
  background: hsl(var(--card) / .88); border: 1px solid hsl(var(--border)); border-radius: 8px;
  box-shadow: 0 1px 3px hsl(222 30% 30% / .08);
}
[data-theme-part="app-header"]::after {
  content: ''; position: absolute; top: 50%; right: 12px; translate: 0 -50%; width: 40px; height: 10px; pointer-events: none;
  background-image: linear-gradient(hsl(var(--primary)), hsl(var(--primary))), linear-gradient(hsl(var(--primary)), hsl(var(--primary))), linear-gradient(hsl(var(--primary)), hsl(var(--primary)));
  background-size: 10px 1.5px; background-position: 0 4px, 15px 4px, 30px 4px; background-repeat: no-repeat; opacity: .75;
}
/* Modern taskbar: centered pill with an accent underline on the active item. */
[data-theme-part="app-nav"] { background: hsl(var(--card) / .8); border: 1px solid hsl(var(--border)); border-radius: 10px; box-shadow: 0 2px 8px hsl(222 30% 30% / .08); }
[data-theme-part="nav-item"] { border-radius: 5px; font-weight: 600; position: relative; }
[data-theme-part="nav-item"]:is([data-state="active"], [aria-current="page"]) {
  background: hsl(var(--primary) / .12); color: hsl(var(--primary)); box-shadow: inset 0 -2.5px 0 hsl(var(--primary)); border-radius: 5px 5px 3px 3px;
}
${ACTIONS} { background: hsl(var(--muted) / .6); border: 1px solid hsl(var(--border)); border-radius: 5px; font-weight: 600; box-shadow: 0 1px 2px hsl(222 30% 30% / .1); }
${ACTIONS}:is([data-state="active"], [aria-selected="true"]) { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground); border-color: transparent; }
${FIELDS} { background: hsl(0 0% 100% / .85); border: 1px solid hsl(var(--border)); border-radius: 5px; box-shadow: inset 0 -1px 0 hsl(var(--primary) / .35); color: hsl(222 30% 14%); }
${FIELDS}:focus { border-color: hsl(var(--primary) / .7); }
${ITEMS} { border-radius: 4px; }
${ITEMS}:is(:hover, [data-highlighted]) { background: hsl(var(--primary) / .1); }
${TOGGLES} { border-radius: 4px; }
[data-theme-part="badge"] { border: 1px solid hsl(var(--primary) / .5); border-radius: 5px; background: hsl(var(--primary) / .1); font-weight: 600; }
[data-theme-part="progress"] { background: hsl(var(--muted)); border-radius: 999px; overflow: hidden; }
[data-theme-part="progress-indicator"] { background: hsl(var(--primary)); border-radius: 999px; }
[data-theme-part="scroll-thumb"] { background: hsl(222 15% 70%); border-radius: 999px; }
${STATE_DETAILS}
${FOCUS_RING}
`
