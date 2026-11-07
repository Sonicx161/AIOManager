// Boot-safe theme primitives: types and pure color math only. This module must
// never import the full theme catalog or its skin CSS, so ThemeContext can stay
// out of the lazy theme chunk. themes.ts re-exports everything from here.

export function hslToHex(hsl: string): string {
    const [h, s, l] = hsl.split(' ').map(v => parseFloat(v))
    const sl = s / 100, ll = l / 100
    const c = (1 - Math.abs(2 * ll - 1)) * sl
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = ll - c / 2
    let r = 0, g = 0, b = 0
    if (h < 60) { r = c; g = x }
    else if (h < 120) { r = x; g = c }
    else if (h < 180) { g = c; b = x }
    else if (h < 240) { g = x; b = c }
    else if (h < 300) { r = x; b = c }
    else { r = c; b = x }
    const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export type Theme =
    | 'light'
    | 'dark'
    | 'nightfall'
    | 'aurora'
    | 'aubergine'
    | 'rose-gold'
    | 'ochin'
    | 'choco-mint'
    | 'cafe'
    | 'hoth'
    | 'sunset'
    | 'cyberpunk'
    | 'synthwave'
    | 'dracula'
    | 'nord'
    | 'torbox'
    | 'real-debrid'
    | 'alldebrid'
    | 'premiumize'
    | 'aiostreams'
    | 'comet'
    | 'elfhosted'
    | 'stremio'
    | 'trakt'
    | 'simkl'
    | 'sonic'
    | 'catppuccin-latte'
    | 'catppuccin-frappe'
    | 'catppuccin-macchiato'
    | 'catppuccin-mocha'
    | 'tokyo-night'
    | 'gruvbox-dark'
    | 'one-dark-pro'
    | 'monokai-pro'
    | 'night-owl'
    | 'solarized-dark'
    | 'rose-pine'
    | 'ayu-mirage'
    | 'cobalt2'
    | 'material-palenight'
    | 'github-dark-dimmed'
    | 'everforest'
    | 'kanagawa'
    | 'parchment'
    | 'high-contrast'
    | 'mermaid'
    | 'ember'
    | 'obsidian-gold'
    | 'clinical-mint'
    | 'crimson'
    | 'amber-glass'
    | 'slate-mono'
    | 'deep-space'
    | 'parchment-dusk'
    | 'parchment-dark'
    | 'vellum'
    | 'sepia'
    | 'manuscript'
    | 'linen'
    | 'driftwood'
    | 'infrared'
    | 'cyberpunk-2077'
    | 'downtown'
    | 'cream-coffee'
    | 'city-sunset'
    | 'dusty-sage'
    | 'faded-rose'
    | 'black-ops'
    | 'oled-green'
    | 'oled-red'
    | 'oled-cyan'
    | 'oled-purple'
    | 'modern-warfare'
    | 'eclipse'
    | 'fusion'
    | 'nuvio'
    | 'realstream'
    | 'light-retro'
    | 'light-mint'
    | 'light-sky'
    | 'light-rose'
    | 'kawaii'
    | 'pastel-peach'
    | 'dusk'
    | 'twilight'
    | 'coral-reef'
    | 'bubblegum'
    | 'citrus'
    | 'sakura'
    | 'tropical'
    | 'spring-meadow'
    | 'lagoon'
    | 'cotton-candy'
    | 'golden-hour'
    | 'terracotta'
    | 'seafoam-light'
    | 'lavender-fields'
    | 'minecraft'
    | 'nvidia'
    | 'amd'
    | 'steam'
    | 'ocean-mist'
    | 'forest-canopy'
    | 'desert-dune'
    | 'berry-blush'
    | 'rose-quartz'
    | 'golden-wheat'
    | 'mint-meadow'
    | 'peach-blossom'
    | 'pokemon'
    | 'pikachu'
    | 'bulbasaur'
    | 'charmander'
    | 'squirtle'
    | 'oled-pink'
    | 'oled-orange'
    | 'oled-yellow'
    | 'emerald'
    | 'sapphire'
    | 'ruby'
    | 'amethyst'
    | 'comic-book'
    | 'comic-book-plus'
    | 'retro-desktop'
    | 'crt-terminal'
    | 'blueprint-live'
    | 'liquid-chrome'
    | 'matrix-rain'
    | 'pip-boy'
    | 'neon-arcade'
    | 'stained-glass'
    | 'lime-zest'
    | 'tangerine'
    | 'turquoise'
    | 'electric-violet'
    | 'hot-coral'
    | 'volcano'
    | 'aurora-borealis'
    | 'toxic-waste'
    | 'indigo-light'
    | 'periwinkle'
    | 'cornflower'
    | 'oled-teal'
    | 'oled-magenta'
    | 'oled-indigo'
    | 'oled-lime'
    | 'pastel-dream'
    | 'neon-dream'
    | 'watermelon'
    | 'candy'
    | 'gamer'
    | 'royal'
    | 'poison-apple'
    | 'tropical-punch'
    | 'ice-cream'
    | 'midnight-carnival'
    | 'dragon-fruit'
    | 'tamtaro'
    | 'dot-matrix'
    | 'washi'
    | 'clay-studio'
    | 'denim'
    | 'arctic-glass'
    | 'sherbet'
    | 'cottage'
    | 'zen-garden'
    | 'origami'
    | 'sonar'
    | 'lava-lamp'
    | 'holo-liquid'
    | 'tidal-pulse'
    | 'win-modern'
    | `custom-${string}`

export interface ThemePalette {
    background: string
    card: string
    cardForeground: string
    primary: string
    primaryForeground?: string
    mutedForeground: string
    muted: string
    destructive: string
    destructiveForeground?: string
    border: string
    input: string
    ring: string
}

export interface CompactPalette {
    background: string
    card: string
    cardForeground: string
    primary: string
    primaryForeground?: string
    mutedForeground: string
    muted: string
    destructive: string
    destructiveForeground?: string
    border: string
    ring?: string
}

export interface ThemePreview {
    background: string
    surface: string
    accent: string
    text: string
    textMuted: string
}

export interface ThemeOption {
    id: Theme
    label: string
    description: string
    emoji: string
    italic?: boolean
    category: 'standard' | 'community'
    subcategory?: 'light' | 'dark' | 'oled'
    palette: ThemePalette
    preview: ThemePreview
    customCss?: string
    logoUrl?: string
}

export function expand(c: CompactPalette): ThemePalette {
    return {
        background: c.background,
        card: c.card,
        cardForeground: c.cardForeground,
        primary: c.primary,
        primaryForeground: c.primaryForeground,
        mutedForeground: c.mutedForeground,
        muted: c.muted,
        destructive: c.destructive,
        destructiveForeground: c.destructiveForeground,
        border: c.border,
        input: c.border,
        ring: c.ring ?? c.primary,
    }
}

export function derivePreview(p: ThemePalette): ThemePreview {
    return {
        background: hslToHex(p.background),
        surface: hslToHex(p.card),
        accent: hslToHex(p.primary),
        text: hslToHex(p.cardForeground),
        textMuted: hslToHex(p.mutedForeground),
    }
}

export function generatePaletteFromAccent(
    hue: number,
    saturation: number,
    base: 'dark' | 'light' | 'oled',
    overrides?: Partial<CompactPalette>,
): CompactPalette {
    const h = Math.round(hue % 360)
    const s = Math.round(Math.max(0, Math.min(100, saturation)))

    if (base === 'oled') {
        return {
            background: `${h} 0% 0%`,
            card: `${h} ${Math.round(s * 0.15)}% 8%`,
            cardForeground: `${h} ${Math.round(s * 0.15)}% 98%`,
            primary: `${h} ${s}% 60%`,
            muted: `${h} ${Math.round(s * 0.1)}% 6%`,
            mutedForeground: `${h} ${Math.round(s * 0.15)}% 50%`,
            destructive: '0 63% 40%',
            border: `${h} ${Math.round(s * 0.15)}% 14%`,
            ...overrides,
        }
    }

    if (base === 'dark') {
        return {
            background: `${h} ${Math.round(s * 0.35)}% 9%`,
            card: `${h} ${Math.round(s * 0.25)}% 16%`,
            cardForeground: `${h} ${Math.round(s * 0.15)}% 98%`,
            primary: `${h} ${s}% 60%`,
            muted: `${h} ${Math.round(s * 0.2)}% 12%`,
            mutedForeground: `${h} ${Math.round(s * 0.15)}% 55%`,
            destructive: '0 63% 40%',
            border: `${h} ${Math.round(s * 0.2)}% 22%`,
            ...overrides,
        }
    } else {
        return {
            background: `${h} ${Math.round(s * 0.25)}% 96%`,
            card: `${h} ${Math.round(s * 0.15)}% 100%`,
            cardForeground: `${h} ${Math.round(s * 0.2)}% 15%`,
            primary: `${h} ${s}% 45%`,
            muted: `${h} ${Math.round(s * 0.15)}% 93%`,
            mutedForeground: `${h} ${Math.round(s * 0.1)}% 40%`,
            destructive: '0 63% 40%',
            border: `${h} ${Math.round(s * 0.15)}% 85%`,
            ...overrides,
        }
    }
}
