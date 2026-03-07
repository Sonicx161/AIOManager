import { createContext, useContext, useEffect, useState, ReactNode } from 'react'



export type Theme =
    | 'light'
    | 'dark'
    | 'midnight'
    | 'aurora'
    | 'aubergine'
    | 'rose-gold' // Added missing one from list
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
    | 'aiometadata'
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
    | 'synthwave-84'
    | 'ayu-mirage'
    | 'cobalt2'
    | 'material-palenight'
    | 'github-dark-dimmed'

// HSL values without the hsl() wrapper - just "H S% L%" format for CSS variables
export interface ThemePalette {
    background: string
    card: string
    cardForeground: string
    popover: string
    popoverForeground: string
    primary: string
    primaryForeground: string
    secondary: string
    secondaryForeground: string
    muted: string
    mutedForeground: string
    accent: string
    accentForeground: string
    destructive: string
    destructiveForeground: string
    border: string
    input: string
    ring: string
}

export interface ThemeOption {
    id: Theme
    label: string
    description: string
    emoji: string
    italic?: boolean
    category: 'standard' | 'community'
    palette: ThemePalette
    // Preview colors for the theme cards (actual hex for previews)
    preview: {
        background: string
        surface: string
        accent: string
        text: string
        textMuted: string
    }
}

export const THEME_OPTIONS: ThemeOption[] = [
    // === LIGHT THEMES ===
    {
        id: 'light',
        label: 'Light',
        description: 'Bright and clean interface',
        emoji: '☀️',
        category: 'standard',
        palette: {
            background: '0 0% 100%',
            card: '0 0% 100%',
            cardForeground: '222 84% 5%',
            popover: '0 0% 100%',
            popoverForeground: '222 84% 5%',
            primary: '221 83% 53%',
            primaryForeground: '0 0% 100%',
            secondary: '220 14% 96%',
            secondaryForeground: '222 47% 11%',
            muted: '220 14% 96%',
            mutedForeground: '220 9% 46%',
            accent: '220 14% 96%',
            accentForeground: '222 47% 11%',
            destructive: '0 84% 60%',
            destructiveForeground: '0 0% 100%',
            border: '220 13% 82%',
            input: '220 13% 82%',
            ring: '221 83% 53%',
        },
        preview: { background: '#ffffff', surface: '#f8fafc', accent: '#3b82f6', text: '#0f172a', textMuted: '#64748b' },
    },
    {
        id: 'hoth',
        label: 'Hoth',
        description: 'Frosted whites with glacial accents',
        emoji: '❄️',
        category: 'standard',
        palette: {
            background: '210 40% 98%',
            card: '0 0% 100%',
            cardForeground: '222 84% 5%',
            popover: '0 0% 100%',
            popoverForeground: '222 84% 5%',
            primary: '199 89% 48%',
            primaryForeground: '0 0% 100%',
            secondary: '210 40% 96%',
            secondaryForeground: '222 47% 11%',
            muted: '210 40% 96%',
            mutedForeground: '215 16% 47%',
            accent: '210 40% 96%',
            accentForeground: '222 47% 11%',
            destructive: '0 84% 60%',
            destructiveForeground: '0 0% 100%',
            border: '214 32% 82%',
            input: '214 32% 82%',
            ring: '199 89% 48%',
        },
        preview: { background: '#f8fafc', surface: '#ffffff', accent: '#0ea5e9', text: '#0f172a', textMuted: '#64748b' },
    },
    // === DARK THEMES ===
    {
        id: 'dark',
        label: 'Nightfall',
        description: 'Balanced contrast for low-light focus',
        emoji: '🌙',
        category: 'standard',
        palette: {
            background: '222 47% 11%',
            card: '217 33% 17%',
            cardForeground: '210 40% 98%',
            popover: '217 33% 17%',
            popoverForeground: '210 40% 98%',
            primary: '217 91% 60%',
            primaryForeground: '0 0% 100%',
            secondary: '217 33% 17%',
            secondaryForeground: '210 40% 98%',
            muted: '217 33% 17%',
            mutedForeground: '215 20% 65%',
            accent: '217 33% 17%',
            accentForeground: '210 40% 98%',
            destructive: '0 63% 31%',
            destructiveForeground: '210 40% 98%',
            border: '217 33% 17%',
            input: '217 33% 17%',
            ring: '224 76% 48%',
        },
        preview: { background: '#0f172a', surface: '#1e293b', accent: '#3b82f6', text: '#e2e8f0', textMuted: '#94a3b8' },
    },
    {
        id: 'midnight',
        label: 'Midnight',
        description: 'High-contrast OLED black',
        emoji: '🌑',
        category: 'standard',
        palette: {
            background: '0 0% 0%',
            card: '0 0% 4%',
            cardForeground: '0 0% 98%',
            popover: '0 0% 4%',
            popoverForeground: '0 0% 98%',
            primary: '45 93% 47%',
            primaryForeground: '0 0% 0%',
            secondary: '0 0% 10%',
            secondaryForeground: '0 0% 98%',
            muted: '0 0% 10%',
            mutedForeground: '0 0% 64%',
            accent: '0 0% 10%',
            accentForeground: '0 0% 98%',
            destructive: '0 63% 31%',
            destructiveForeground: '0 0% 98%',
            border: '0 0% 15%',
            input: '0 0% 15%',
            ring: '45 93% 47%',
        },
        preview: { background: '#000000', surface: '#0a0a0a', accent: '#fbbf24', text: '#fafafa', textMuted: '#a3a3a3' },
    },
    {
        id: 'dracula',
        label: 'Dracula',
        description: 'The classic developer theme',
        emoji: '🧛',
        category: 'standard',
        palette: {
            background: '231 15% 18%',
            card: '232 14% 24%',
            cardForeground: '60 30% 96%',
            popover: '232 14% 24%',
            popoverForeground: '60 30% 96%',
            primary: '265 89% 78%',
            primaryForeground: '231 15% 18%',
            secondary: '232 14% 31%',
            secondaryForeground: '60 30% 96%',
            muted: '232 14% 31%',
            mutedForeground: '225 27% 51%',
            accent: '232 14% 31%',
            accentForeground: '60 30% 96%',
            destructive: '0 100% 67%',
            destructiveForeground: '60 30% 96%',
            border: '232 14% 31%',
            input: '232 14% 31%',
            ring: '265 89% 78%',
        },
        preview: { background: '#282a36', surface: '#343746', accent: '#bd93f9', text: '#f8f8f2', textMuted: '#6272a4' },
    },
    {
        id: 'nord',
        label: 'Nord',
        description: 'Arctic, north-bluish color palette',
        emoji: '🏔️',
        category: 'standard',
        palette: {
            background: '220 16% 22%',
            card: '220 17% 27%',
            cardForeground: '219 28% 88%',
            popover: '220 17% 27%',
            popoverForeground: '219 28% 88%',
            primary: '193 43% 67%',
            primaryForeground: '220 16% 22%',
            secondary: '220 17% 32%',
            secondaryForeground: '219 28% 88%',
            muted: '220 17% 32%',
            mutedForeground: '92 28% 65%',
            accent: '220 17% 32%',
            accentForeground: '219 28% 88%',
            destructive: '354 42% 56%',
            destructiveForeground: '219 28% 88%',
            border: '220 16% 36%',
            input: '220 16% 36%',
            ring: '193 43% 67%',
        },
        preview: { background: '#2e3440', surface: '#3b4252', accent: '#88c0d0', text: '#eceff4', textMuted: '#a3be8c' },
    },
    // === COLORFUL THEMES ===
    {
        id: 'aurora',
        label: 'Aurora',
        description: 'Violet twilight with neon glow',
        emoji: '🌌',
        category: 'standard',
        palette: {
            background: '229 35% 12%',
            card: '228 24% 15%',
            cardForeground: '240 100% 98%',
            popover: '228 24% 15%',
            popoverForeground: '240 100% 98%',
            primary: '271 91% 65%',
            primaryForeground: '0 0% 100%',
            secondary: '228 22% 21%',
            secondaryForeground: '240 100% 98%',
            muted: '228 22% 21%',
            mutedForeground: '229 84% 81%',
            accent: '228 22% 21%',
            accentForeground: '240 100% 98%',
            destructive: '347 77% 50%',
            destructiveForeground: '240 100% 98%',
            border: '228 20% 24%',
            input: '228 20% 24%',
            ring: '271 91% 65%',
        },
        preview: { background: '#141827', surface: '#1e2431', accent: '#a855f7', text: '#f4f5ff', textMuted: '#a5b4fc' },
    },
    {
        id: 'aubergine',
        label: 'Aubergine',
        description: 'Rich purples with vibrant highlights',
        emoji: '🍆',
        category: 'standard',
        palette: {
            background: '277 43% 11%',
            card: '277 30% 17%',
            cardForeground: '270 100% 98%',
            popover: '277 30% 17%',
            popoverForeground: '270 100% 98%',
            primary: '277 70% 59%',
            primaryForeground: '0 0% 100%',
            secondary: '277 26% 24%',
            secondaryForeground: '270 100% 98%',
            muted: '277 26% 24%',
            mutedForeground: '277 53% 86%',
            accent: '277 26% 24%',
            accentForeground: '270 100% 98%',
            destructive: '347 77% 50%',
            destructiveForeground: '270 100% 98%',
            border: '277 23% 29%',
            input: '277 23% 29%',
            ring: '277 70% 59%',
        },
        preview: { background: '#1f1029', surface: '#2c1c3a', accent: '#9d4edd', text: '#f8f5ff', textMuted: '#d8c4f0' },
    },
    {
        id: 'ochin',
        label: 'Ochin',
        description: 'Ocean blues with soft highlights',
        emoji: '🌊',
        category: 'standard',
        palette: {
            background: '213 53% 10%',
            card: '213 40% 14%',
            cardForeground: '210 40% 98%',
            popover: '213 40% 14%',
            popoverForeground: '210 40% 98%',
            primary: '198 93% 60%',
            primaryForeground: '213 53% 10%',
            secondary: '213 35% 19%',
            secondaryForeground: '210 40% 98%',
            muted: '213 35% 19%',
            mutedForeground: '199 92% 75%',
            accent: '213 35% 19%',
            accentForeground: '210 40% 98%',
            destructive: '0 63% 31%',
            destructiveForeground: '210 40% 98%',
            border: '213 35% 25%',
            input: '213 35% 25%',
            ring: '198 93% 60%',
        },
        preview: { background: '#0c1929', surface: '#132337', accent: '#38bdf8', text: '#f1f5f9', textMuted: '#7dd3fc' },
    },
    {
        id: 'choco-mint',
        label: 'Choco Mint',
        description: 'Earthy neutrals with mint highlights',
        emoji: '🍫',
        category: 'standard',
        palette: {
            background: '120 10% 11%',
            card: '120 10% 15%',
            cardForeground: '120 60% 97%',
            popover: '120 10% 15%',
            popoverForeground: '120 60% 97%',
            primary: '142 71% 45%',
            primaryForeground: '0 0% 100%',
            secondary: '120 10% 20%',
            secondaryForeground: '120 60% 97%',
            muted: '120 10% 20%',
            mutedForeground: '142 77% 73%',
            accent: '120 10% 20%',
            accentForeground: '120 60% 97%',
            destructive: '0 63% 31%',
            destructiveForeground: '120 60% 97%',
            border: '120 10% 23%',
            input: '120 10% 23%',
            ring: '142 71% 45%',
        },
        preview: { background: '#1a1f1b', surface: '#242b25', accent: '#4ade80', text: '#f0fdf4', textMuted: '#86efac' },
    },
    {
        id: 'cafe',
        label: 'Café',
        description: 'Warm coffee tones for focus',
        emoji: '☕',
        category: 'standard',
        palette: {
            background: '24 20% 9%',
            card: '24 16% 13%',
            cardForeground: '44 87% 94%',
            popover: '24 16% 13%',
            popoverForeground: '44 87% 94%',
            primary: '45 93% 47%',
            primaryForeground: '24 20% 9%',
            secondary: '24 14% 17%',
            secondaryForeground: '44 87% 94%',
            muted: '24 14% 17%',
            mutedForeground: '48 96% 72%',
            accent: '24 14% 17%',
            accentForeground: '44 87% 94%',
            destructive: '0 63% 31%',
            destructiveForeground: '44 87% 94%',
            border: '24 13% 22%',
            input: '24 13% 22%',
            ring: '45 93% 47%',
        },
        preview: { background: '#1c1612', surface: '#28211b', accent: '#fbbf24', text: '#fef3c7', textMuted: '#fcd34d' },
    },
    {
        id: 'sunset',
        label: 'Sunset',
        description: 'Warm oranges and golden hour vibes',
        emoji: '🌅',
        category: 'standard',
        palette: {
            background: '20 25% 8%',
            card: '20 20% 12%',
            cardForeground: '33 100% 96%',
            popover: '20 20% 12%',
            popoverForeground: '33 100% 96%',
            primary: '27 96% 61%',
            primaryForeground: '20 25% 8%',
            secondary: '20 17% 16%',
            secondaryForeground: '33 100% 96%',
            muted: '20 17% 16%',
            mutedForeground: '27 97% 72%',
            accent: '20 17% 16%',
            accentForeground: '33 100% 96%',
            destructive: '0 63% 31%',
            destructiveForeground: '33 100% 96%',
            border: '20 15% 22%',
            input: '20 15% 22%',
            ring: '27 96% 61%',
        },
        preview: { background: '#1a1410', surface: '#261e18', accent: '#fb923c', text: '#fff7ed', textMuted: '#fdba74' },
    },
    {
        id: 'rose-gold',
        label: 'Rose Gold',
        description: 'Soft pinks and elegant golds',
        emoji: '🌸',
        category: 'standard',
        palette: {
            background: '340 15% 9%',
            card: '340 13% 13%',
            cardForeground: '327 73% 97%',
            popover: '340 13% 13%',
            popoverForeground: '327 73% 97%',
            primary: '330 81% 60%',
            primaryForeground: '0 0% 100%',
            secondary: '340 12% 18%',
            secondaryForeground: '327 73% 97%',
            muted: '340 12% 18%',
            mutedForeground: '330 90% 82%',
            accent: '340 12% 18%',
            accentForeground: '327 73% 97%',
            destructive: '0 63% 31%',
            destructiveForeground: '327 73% 97%',
            border: '340 11% 24%',
            input: '340 11% 24%',
            ring: '330 81% 60%',
        },
        preview: { background: '#1a1517', surface: '#261d20', accent: '#f472b6', text: '#fdf2f8', textMuted: '#f9a8d4' },
    },
    {
        id: 'cyberpunk',
        label: 'Cyberpunk',
        description: 'Neon pink and cyan on dark',
        emoji: '🤖',
        category: 'standard',
        palette: {
            background: '240 33% 4%',
            card: '240 20% 8%',
            cardForeground: '0 0% 96%',
            popover: '240 20% 8%',
            popoverForeground: '0 0% 96%',
            primary: '292 91% 83%',
            primaryForeground: '240 33% 4%',
            secondary: '240 17% 12%',
            secondaryForeground: '0 0% 96%',
            muted: '240 17% 12%',
            mutedForeground: '187 92% 69%',
            accent: '240 17% 12%',
            accentForeground: '0 0% 96%',
            destructive: '338 100% 50%',
            destructiveForeground: '0 0% 96%',
            border: '240 15% 18%',
            input: '240 15% 18%',
            ring: '292 91% 83%',
        },
        preview: { background: '#0a0a0f', surface: '#12121a', accent: '#f0abfc', text: '#f5f5f5', textMuted: '#22d3ee' },
    },
    {
        id: 'synthwave',
        label: 'Synthwave',
        description: '80s retro vibes with neon gradients',
        emoji: '🎮',
        category: 'standard',
        palette: {
            background: '277 30% 11%',
            card: '277 26% 14%',
            cardForeground: '300 100% 100%',
            popover: '277 26% 14%',
            popoverForeground: '300 100% 100%',
            primary: '324 100% 70%',
            primaryForeground: '277 30% 11%',
            secondary: '277 24% 18%',
            secondaryForeground: '300 100% 100%',
            muted: '277 24% 18%',
            mutedForeground: '200 100% 79%',
            accent: '277 24% 18%',
            accentForeground: '300 100% 100%',
            destructive: '347 100% 61%',
            destructiveForeground: '300 100% 100%',
            border: '277 22% 23%',
            input: '277 22% 23%',
            ring: '324 100% 70%',
        },
        preview: { background: '#1a1025', surface: '#241533', accent: '#ff6ad5', text: '#ffeeff', textMuted: '#94d0ff' },
    },
    // === DEVELOPER THEMES ===
    {
        id: 'catppuccin-latte',
        label: 'Catppuccin Latte',
        description: 'Our lightest theme harmoniously inverting the essence of Catppuccin',
        emoji: '☕',
        category: 'standard',
        palette: {
            background: '220 23% 95%',
            card: '220 23% 89%',
            cardForeground: '234 16% 35%',
            popover: '220 23% 89%',
            popoverForeground: '234 16% 35%',
            primary: '266 85% 58%',
            primaryForeground: '220 23% 95%',
            secondary: '220 23% 89%',
            secondaryForeground: '234 16% 35%',
            muted: '220 23% 89%',
            mutedForeground: '231 10% 59%',
            accent: '220 23% 89%',
            accentForeground: '234 16% 35%',
            destructive: '351 74% 57%',
            destructiveForeground: '220 23% 95%',
            border: '231 10% 89%',
            input: '231 10% 89%',
            ring: '266 85% 58%',
        },
        preview: { background: '#eff1f5', surface: '#ccd0da', accent: '#8839ef', text: '#4c4f69', textMuted: '#8c8fa1' },
    },
    {
        id: 'catppuccin-frappe',
        label: 'Catppuccin Frappé',
        description: 'A less vibrant alternative using subdued colors for a muted aesthetic',
        emoji: '☕',
        category: 'standard',
        palette: {
            background: '229 19% 23%',
            card: '229 19% 27%',
            cardForeground: '227 70% 87%',
            popover: '229 19% 27%',
            popoverForeground: '227 70% 87%',
            primary: '277 59% 76%',
            primaryForeground: '229 19% 23%',
            secondary: '229 19% 27%',
            secondaryForeground: '227 70% 87%',
            muted: '229 19% 27%',
            mutedForeground: '229 14% 52%',
            accent: '229 19% 27%',
            accentForeground: '227 70% 87%',
            destructive: '354 75% 67%',
            destructiveForeground: '229 19% 23%',
            border: '229 14% 52%',
            input: '229 14% 52%',
            ring: '277 59% 76%',
        },
        preview: { background: '#303446', surface: '#414559', accent: '#ca9ee6', text: '#c6d0f5', textMuted: '#737994' },
    },
    {
        id: 'catppuccin-macchiato',
        label: 'Catppuccin Macchiato',
        description: 'Medium contrast with gentle colors creating a soothing atmosphere',
        emoji: '☕',
        category: 'standard',
        palette: {
            background: '232 23% 18%',
            card: '232 23% 22%',
            cardForeground: '227 70% 88%',
            popover: '232 23% 22%',
            popoverForeground: '227 70% 88%',
            primary: '267 83% 80%',
            primaryForeground: '232 23% 18%',
            secondary: '232 23% 22%',
            secondaryForeground: '227 70% 88%',
            muted: '232 23% 22%',
            mutedForeground: '231 16% 57%',
            accent: '232 23% 22%',
            accentForeground: '227 70% 88%',
            destructive: '353 74% 67%',
            destructiveForeground: '232 23% 18%',
            border: '231 16% 57%',
            input: '231 16% 57%',
            ring: '267 83% 80%',
        },
        preview: { background: '#24273a', surface: '#363a4f', accent: '#c6a0f6', text: '#cad3f5', textMuted: '#8087a2' },
    },
    {
        id: 'catppuccin-mocha',
        label: 'Catppuccin Mocha',
        description: 'Soothing pastel theme for the high-spirited',
        emoji: '☕',
        category: 'standard',
        palette: {
            background: '240 21% 15%',
            card: '240 21% 19%',
            cardForeground: '226 64% 88%',
            popover: '240 21% 19%',
            popoverForeground: '226 64% 88%',
            primary: '267 84% 81%',
            primaryForeground: '240 21% 15%',
            secondary: '240 21% 19%',
            secondaryForeground: '226 64% 88%',
            muted: '240 21% 19%',
            mutedForeground: '231 11% 47%',
            accent: '240 21% 19%',
            accentForeground: '226 64% 88%',
            destructive: '343 81% 75%',
            destructiveForeground: '240 21% 15%',
            border: '231 11% 47%',
            input: '231 11% 47%',
            ring: '267 84% 81%',
        },
        preview: { background: '#1e1e2e', surface: '#313244', accent: '#cba6f7', text: '#cdd6f4', textMuted: '#6c7086' },
    },
    {
        id: 'tokyo-night',
        label: 'Tokyo Night',
        description: 'A clean, dark theme that celebrates the lights of downtown Tokyo at night',
        emoji: '🗼',
        category: 'standard',
        palette: {
            background: '235 19% 13%',
            card: '240 15% 10%',
            cardForeground: '229 59% 85%',
            popover: '240 15% 10%',
            popoverForeground: '229 59% 85%',
            primary: '226 90% 72%',
            primaryForeground: '235 19% 13%',
            secondary: '240 15% 10%',
            secondaryForeground: '229 59% 85%',
            muted: '240 15% 10%',
            mutedForeground: '229 23% 44%',
            accent: '240 15% 10%',
            accentForeground: '229 59% 85%',
            destructive: '349 89% 72%',
            destructiveForeground: '235 19% 13%',
            border: '228 23% 21%',
            input: '228 23% 21%',
            ring: '226 90% 72%',
        },
        preview: { background: '#1a1b26', surface: '#16161e', accent: '#7aa2f7', text: '#c0caf5', textMuted: '#565f89' },
    },
    {
        id: 'gruvbox-dark',
        label: 'Gruvbox Dark',
        description: 'Retro groove color scheme',
        emoji: '📻',
        category: 'standard',
        palette: {
            background: '0 0% 16%',
            card: '20 5% 23%',
            cardForeground: '43 47% 81%',
            popover: '20 5% 23%',
            popoverForeground: '43 47% 81%',
            primary: '27 99% 55%',
            primaryForeground: '0 0% 16%',
            secondary: '20 5% 23%',
            secondaryForeground: '43 47% 81%',
            muted: '20 5% 23%',
            mutedForeground: '34 22% 59%',
            accent: '20 5% 23%',
            accentForeground: '43 47% 81%',
            destructive: '1 73% 46%',
            destructiveForeground: '43 47% 81%',
            border: '20 5% 23%',
            input: '20 5% 23%',
            ring: '27 99% 55%',
        },
        preview: { background: '#282828', surface: '#3c3836', accent: '#fe8019', text: '#ebdbb2', textMuted: '#a89984' },
    },
    {
        id: 'one-dark-pro',
        label: 'One Dark Pro',
        description: 'Iconic Atom One Dark vibes',
        emoji: '⚛️',
        category: 'standard',
        palette: {
            background: '220 13% 18%',
            card: '216 13% 15%',
            cardForeground: '219 14% 71%',
            popover: '216 13% 15%',
            popoverForeground: '219 14% 71%',
            primary: '207 82% 66%',
            primaryForeground: '220 13% 18%',
            secondary: '216 13% 15%',
            secondaryForeground: '219 14% 71%',
            muted: '216 13% 15%',
            mutedForeground: '219 10% 40%',
            accent: '216 13% 15%',
            accentForeground: '219 14% 71%',
            destructive: '355 65% 65%',
            destructiveForeground: '219 14% 71%',
            border: '216 13% 18%',
            input: '216 13% 18%',
            ring: '207 82% 66%',
        },
        preview: { background: '#282c34', surface: '#21252b', accent: '#61afef', text: '#abb2bf', textMuted: '#5c6370' },
    },
    {
        id: 'monokai-pro',
        label: 'Monokai Pro',
        description: 'Beautiful functionality for pro dev',
        emoji: '🍌',
        category: 'standard',
        palette: {
            background: '300 4% 17%',
            card: '300 4% 13%',
            cardForeground: '60 40% 98%',
            popover: '300 4% 13%',
            popoverForeground: '60 40% 98%',
            primary: '45 100% 70%',
            primaryForeground: '300 4% 17%',
            secondary: '300 4% 13%',
            secondaryForeground: '60 40% 98%',
            muted: '300 4% 13%',
            mutedForeground: '300 2% 44%',
            accent: '300 4% 13%',
            accentForeground: '60 40% 98%',
            destructive: '345 100% 69%',
            destructiveForeground: '60 40% 98%',
            border: '300 4% 22%',
            input: '300 4% 22%',
            ring: '45 100% 70%',
        },
        preview: { background: '#2d2a2e', surface: '#221f22', accent: '#ffd866', text: '#fcfcfa', textMuted: '#727072' },
    },
    {
        id: 'night-owl',
        label: 'Night Owl',
        description: 'Fine-tuned for late night coding',
        emoji: '🦉',
        category: 'standard',
        palette: {
            background: '207 95% 8%',
            card: '207 92% 5%',
            cardForeground: '217 40% 88%',
            popover: '207 92% 5%',
            popoverForeground: '217 40% 88%',
            primary: '221 100% 75%',
            primaryForeground: '207 95% 8%',
            secondary: '207 92% 5%',
            secondaryForeground: '217 40% 88%',
            muted: '207 92% 5%',
            mutedForeground: '207 23% 48%',
            accent: '207 92% 5%',
            accentForeground: '217 40% 88%',
            destructive: '3 86% 63%',
            destructiveForeground: '217 40% 88%',
            border: '206 60% 15%',
            input: '206 60% 15%',
            ring: '221 100% 75%',
        },
        preview: { background: '#011627', surface: '#010e1a', accent: '#82aaff', text: '#d6deeb', textMuted: '#5f7e97' },
    },
    {
        id: 'solarized-dark',
        label: 'Solarized Dark',
        description: 'Precision colors for machines and people',
        emoji: '🌤️',
        category: 'standard',
        palette: {
            background: '192 100% 11%',
            card: '192 81% 14%',
            cardForeground: '186 9% 55%',
            popover: '192 81% 14%',
            popoverForeground: '186 9% 55%',
            primary: '205 69% 49%',
            primaryForeground: '192 100% 11%',
            secondary: '192 81% 14%',
            secondaryForeground: '186 9% 55%',
            muted: '192 81% 14%',
            mutedForeground: '194 14% 40%',
            accent: '192 81% 14%',
            accentForeground: '186 9% 55%',
            destructive: '1 71% 52%',
            destructiveForeground: '186 9% 55%',
            border: '192 81% 20%',
            input: '192 81% 20%',
            ring: '205 69% 49%',
        },
        preview: { background: '#002b36', surface: '#073642', accent: '#268bd2', text: '#839496', textMuted: '#586e75' },
    },
    {
        id: 'rose-pine',
        label: 'Rosé Pine',
        description: 'All natural pine, faux fur and a bit of soho vibes',
        emoji: '🌹',
        category: 'standard',
        palette: {
            background: '249 22% 12%',
            card: '247 23% 15%',
            cardForeground: '245 42% 91%',
            popover: '247 23% 15%',
            popoverForeground: '245 42% 91%',
            primary: '2 46% 82%',
            primaryForeground: '249 22% 12%',
            secondary: '247 23% 15%',
            secondaryForeground: '245 42% 91%',
            muted: '247 23% 15%',
            mutedForeground: '248 15% 61%',
            accent: '247 23% 15%',
            accentForeground: '245 42% 91%',
            destructive: '343 76% 68%',
            destructiveForeground: '249 22% 12%',
            border: '247 23% 20%',
            input: '247 23% 20%',
            ring: '2 46% 82%',
        },
        preview: { background: '#191724', surface: '#1f1d2e', accent: '#ebbcba', text: '#e0def4', textMuted: '#908caa' },
    },
    {
        id: 'synthwave-84',
        label: 'SynthWave \'84',
        description: 'Vibrant neon 80s aesthetics outrun theme',
        emoji: '📼',
        category: 'standard',
        palette: {
            background: '250 21% 17%',
            card: '249 19% 13%',
            cardForeground: '264 56% 96%',
            popover: '249 19% 13%',
            popoverForeground: '264 56% 96%',
            primary: '317 100% 75%',
            primaryForeground: '250 21% 17%',
            secondary: '249 19% 13%',
            secondaryForeground: '264 56% 96%',
            muted: '249 19% 13%',
            mutedForeground: '233 26% 63%',
            accent: '249 19% 13%',
            accentForeground: '264 56% 96%',
            destructive: '356 99% 63%',
            destructiveForeground: '264 56% 96%',
            border: '249 19% 23%',
            input: '249 19% 23%',
            ring: '317 100% 75%',
        },
        preview: { background: '#262335', surface: '#1d1b28', accent: '#ff7edb', text: '#f4eefd', textMuted: '#848bbd' },
    },
    {
        id: 'ayu-mirage',
        label: 'Ayu Mirage',
        description: 'Simple, bright and elegant theme',
        emoji: '🌅',
        category: 'standard',
        palette: {
            background: '223 22% 16%',
            card: '222 22% 12%',
            cardForeground: '60 4% 79%',
            popover: '222 22% 12%',
            popoverForeground: '60 4% 79%',
            primary: '40 100% 70%',
            primaryForeground: '223 22% 16%',
            secondary: '222 22% 12%',
            secondaryForeground: '60 4% 79%',
            muted: '222 22% 12%',
            mutedForeground: '219 11% 49%',
            accent: '222 22% 12%',
            accentForeground: '60 4% 79%',
            destructive: '7 81% 71%',
            destructiveForeground: '223 22% 16%',
            border: '222 22% 20%',
            input: '222 22% 20%',
            ring: '40 100% 70%',
        },
        preview: { background: '#1f2430', surface: '#171b24', accent: '#ffcc66', text: '#cbccc6', textMuted: '#707a8c' },
    },
    {
        id: 'cobalt2',
        label: 'Cobalt2',
        description: 'Blue-yellow high contrast theme by Wes Bos',
        emoji: '🔥',
        category: 'standard',
        palette: {
            background: '205 49% 19%',
            card: '207 51% 15%',
            cardForeground: '0 0% 93%',
            popover: '207 51% 15%',
            popoverForeground: '0 0% 93%',
            primary: '47 100% 50%',
            primaryForeground: '205 49% 19%',
            secondary: '207 51% 15%',
            secondaryForeground: '0 0% 93%',
            muted: '207 51% 15%',
            mutedForeground: '206 11% 45%',
            accent: '207 51% 15%',
            accentForeground: '0 0% 93%',
            destructive: '344 100% 69%',
            destructiveForeground: '0 0% 93%',
            border: '207 51% 25%',
            input: '207 51% 25%',
            ring: '47 100% 50%',
        },
        preview: { background: '#193549', surface: '#122738', accent: '#ffc600', text: '#eeeeee', textMuted: '#65737e' },
    },
    {
        id: 'material-palenight',
        label: 'Material Palenight',
        description: 'Elegant and juicy Material Design theme',
        emoji: '🎨',
        category: 'standard',
        palette: {
            background: '228 20% 20%',
            card: '229 23% 14%',
            cardForeground: '231 28% 73%',
            popover: '229 23% 14%',
            popoverForeground: '231 28% 73%',
            primary: '276 68% 74%',
            primaryForeground: '228 20% 20%',
            secondary: '229 23% 14%',
            secondaryForeground: '231 28% 73%',
            muted: '229 23% 14%',
            mutedForeground: '231 18% 49%',
            accent: '229 23% 14%',
            accentForeground: '231 28% 73%',
            destructive: '357 80% 69%',
            destructiveForeground: '228 20% 20%',
            border: '229 23% 20%',
            input: '229 23% 20%',
            ring: '276 68% 74%',
        },
        preview: { background: '#292d3e', surface: '#1b1e2b', accent: '#c792ea', text: '#a6accd', textMuted: '#676e95' },
    },
    {
        id: 'github-dark-dimmed',
        label: 'GitHub Dark Dimmed',
        description: 'Softer contrast for less eye strain',
        emoji: '🐙',
        category: 'standard',
        palette: {
            background: '215 15% 16%',
            card: '215 18% 13%',
            cardForeground: '210 17% 73%',
            popover: '215 18% 13%',
            popoverForeground: '210 17% 73%',
            primary: '213 90% 64%',
            primaryForeground: '215 15% 16%',
            secondary: '215 18% 13%',
            secondaryForeground: '210 17% 73%',
            muted: '215 18% 13%',
            mutedForeground: '210 10% 51%',
            accent: '215 18% 13%',
            accentForeground: '210 17% 73%',
            destructive: '3 75% 60%',
            destructiveForeground: '210 17% 73%',
            border: '215 18% 23%',
            input: '215 18% 23%',
            ring: '213 90% 64%',
        },
        preview: { background: '#22272e', surface: '#1c2128', accent: '#539bf5', text: '#adbac7', textMuted: '#768390' },
    },
    // === COMMUNITY THEMES ===
    {
        id: 'stremio',
        label: 'Stremio',
        description: 'Authorized community purple',
        emoji: '🟣',
        category: 'community',
        palette: {
            background: '258 46% 12%',
            card: '258 43% 16%',
            cardForeground: '258 30% 98%',
            popover: '258 43% 16%',
            popoverForeground: '258 30% 98%',
            primary: '262 53% 56%',
            primaryForeground: '0 0% 100%',
            secondary: '258 35% 22%',
            secondaryForeground: '258 30% 98%',
            muted: '258 35% 22%',
            mutedForeground: '258 40% 75%',
            accent: '258 35% 22%',
            accentForeground: '258 30% 98%',
            destructive: '0 63% 31%',
            destructiveForeground: '258 30% 98%',
            border: '258 30% 28%',
            input: '258 30% 28%',
            ring: '262 53% 56%',
        },
        preview: { background: '#18112d', surface: '#22183b', accent: '#8c52ff', text: '#f3f0fb', textMuted: '#a594cc' },
    },
    {
        id: 'torbox',
        label: 'TorBox',
        description: 'Digital green cloud',
        emoji: '📦',
        category: 'community',
        palette: {
            background: '185 30% 6%', // Darkened and Desaturated Teal (Usable Dark Mode)
            card: '185 25% 10%',
            cardForeground: '160 30% 98%',
            popover: '185 25% 10%',
            popoverForeground: '160 30% 98%',
            primary: '161 56% 47%', // #34BA90 (Mint from SVG)
            primaryForeground: '0 0% 100%',
            secondary: '185 20% 16%',
            secondaryForeground: '160 30% 98%',
            muted: '185 20% 16%',
            mutedForeground: '160 20% 70%',
            accent: '185 20% 16%',
            accentForeground: '160 30% 98%',
            destructive: '0 60% 40%',
            destructiveForeground: '160 30% 98%',
            border: '185 20% 20%',
            input: '185 20% 20%',
            ring: '161 56% 47%',
        },
        preview: { background: '#0b1414', surface: '#0f1a1a', accent: '#34ba90', text: '#ecf9f5', textMuted: '#8da8a0' },
    },
    {
        id: 'real-debrid',
        label: 'Real-Debrid',
        description: 'Sky blue connect',
        emoji: '🍋',
        category: 'community',
        palette: {
            background: '205 30% 10%', // Slate Dark
            card: '205 25% 14%',
            cardForeground: '200 30% 98%',
            popover: '205 25% 14%',
            popoverForeground: '200 30% 98%',
            primary: '202 70% 78%', // #9FD3EE (Extracted Light Blue)
            primaryForeground: '205 50% 10%',
            secondary: '205 20% 20%',
            secondaryForeground: '200 30% 98%',
            muted: '205 20% 20%',
            mutedForeground: '205 15% 70%',
            accent: '205 20% 20%',
            accentForeground: '200 30% 98%',
            destructive: '0 63% 31%',
            destructiveForeground: '0 0% 98%',
            border: '205 20% 25%',
            input: '205 20% 25%',
            ring: '202 70% 78%',
        },
        preview: { background: '#12161a', surface: '#1a1f24', accent: '#9fd3ee', text: '#f0faff', textMuted: '#9aaabb' },
    },
    {
        id: 'alldebrid',
        label: 'AllDebrid',
        description: 'Amber energy flow',
        emoji: '🟠',
        category: 'community',
        palette: {
            background: '36 30% 8%',
            card: '36 25% 12%',
            cardForeground: '36 30% 98%',
            popover: '36 25% 12%',
            popoverForeground: '36 30% 98%',
            primary: '36 89% 51%',
            primaryForeground: '0 0% 100%',
            secondary: '36 20% 18%',
            secondaryForeground: '36 30% 98%',
            muted: '36 20% 18%',
            mutedForeground: '36 20% 70%',
            accent: '36 20% 18%',
            accentForeground: '36 30% 98%',
            destructive: '0 60% 40%',
            destructiveForeground: '36 30% 98%',
            border: '36 20% 20%',
            input: '36 20% 20%',
            ring: '36 89% 51%',
        },
        preview: { background: '#1a160e', surface: '#262015', accent: '#f39c12', text: '#fdfbf6', textMuted: '#b3a794' },
    },
    {
        id: 'premiumize',
        label: 'Premiumize',
        description: 'Deep ocean link',
        emoji: '🌊',
        category: 'community',
        palette: {
            background: '208 40% 10%', // Dark Blue background
            card: '208 35% 14%',
            cardForeground: '208 10% 98%',
            popover: '208 35% 14%',
            popoverForeground: '208 10% 98%',
            primary: '48 100% 50%', // #FFCC00 (Yellow Checkmark -> Primary/Buttons)
            primaryForeground: '0 0% 10%',
            secondary: '0 80% 40%', // #AA0000 (Red Figure -> Secondary/Highlights)
            secondaryForeground: '0 0% 98%',
            muted: '208 25% 20%',
            mutedForeground: '208 20% 70%',
            accent: '0 80% 40%', // Red Accent
            accentForeground: '0 0% 98%',
            destructive: '0 60% 40%',
            destructiveForeground: '208 30% 98%',
            border: '208 25% 25%',
            input: '208 25% 25%',
            ring: '48 100% 50%',
        },
        preview: { background: '#0f161e', surface: '#151e29', accent: '#ffcc00', text: '#f6faff', textMuted: '#99b3ca' },
    },
    {
        id: 'aiostreams',
        label: 'AIOStreams',
        description: 'Pure Monochrome',
        emoji: '📡',
        category: 'community',
        palette: {
            background: '0 0% 5%', // Almost Pure Black
            card: '0 0% 10%',
            cardForeground: '0 0% 98%',
            popover: '0 0% 10%',
            popoverForeground: '0 0% 98%',
            primary: '0 0% 100%', // White
            primaryForeground: '0 0% 0%',
            secondary: '0 0% 18%',
            secondaryForeground: '0 0% 98%',
            muted: '0 0% 18%',
            mutedForeground: '0 0% 60%',
            accent: '0 0% 18%',
            accentForeground: '0 0% 98%',
            destructive: '0 60% 40%',
            destructiveForeground: '0 0% 98%',
            border: '0 0% 20%',
            input: '0 0% 20%',
            ring: '0 0% 100%',
        },
        preview: { background: '#0d0d0d', surface: '#1a1a1a', accent: '#ffffff', text: '#ffffff', textMuted: '#999999' },
    },
    {
        id: 'aiometadata',
        label: 'AIOMetadata',
        description: 'Deep data teal',
        emoji: '🔍',
        category: 'community',
        palette: {
            background: '176 70% 8%', // Deep Teal Dark
            card: '176 50% 12%',
            cardForeground: '176 30% 98%',
            popover: '176 50% 12%',
            popoverForeground: '176 30% 98%',
            primary: '175 100% 40%', // #105E59 (Extracted Base) - used as primary for brand
            primaryForeground: '0 0% 100%',
            secondary: '176 30% 20%',
            secondaryForeground: '176 30% 98%',
            muted: '176 30% 20%',
            mutedForeground: '176 20% 70%',
            accent: '176 30% 20%',
            accentForeground: '176 30% 98%',
            destructive: '0 60% 40%',
            destructiveForeground: '176 30% 98%',
            border: '176 30% 25%',
            input: '176 30% 25%',
            ring: '175 100% 40%', // Match primary
        },
        preview: { background: '#061a19', surface: '#0f2625', accent: '#105e59', text: '#e6f2f2', textMuted: '#99b3b3' },
    },
    {
        id: 'comet',
        label: 'Comet',
        description: 'Cosmic speed teal',
        emoji: '☄️',
        category: 'community',
        palette: {
            background: '220 30% 6%', // Dark Navy
            card: '220 25% 10%',
            cardForeground: '170 30% 98%',
            popover: '220 25% 10%',
            popoverForeground: '170 30% 98%',
            primary: '165 80% 60%', // Minty Teal
            primaryForeground: '220 40% 5%',
            secondary: '220 20% 15%',
            secondaryForeground: '170 30% 98%',
            muted: '220 20% 15%',
            mutedForeground: '220 20% 60%',
            accent: '220 20% 15%',
            accentForeground: '170 30% 98%',
            destructive: '0 60% 40%',
            destructiveForeground: '170 30% 98%',
            border: '220 20% 18%',
            input: '220 20% 18%',
            ring: '165 80% 60%',
        },
        preview: { background: '#0a0e14', surface: '#10161f', accent: '#47e6b5', text: '#f5fffc', textMuted: '#94b8b0' },
    },
    {
        id: 'elfhosted',
        label: 'ElfHosted',
        description: 'Open source stream hosting',
        emoji: '🧝',
        category: 'community',
        palette: {
            background: '96 40% 10%', // Darker shade of #437820
            card: '96 35% 14%',
            cardForeground: '96 30% 98%',
            popover: '96 35% 14%',
            popoverForeground: '96 30% 98%',
            primary: '96 58% 30%', // #437820 (Extracted)
            primaryForeground: '0 0% 100%',
            secondary: '96 25% 20%',
            secondaryForeground: '96 30% 98%',
            muted: '96 25% 20%',
            mutedForeground: '96 20% 70%',
            accent: '96 25% 20%',
            accentForeground: '96 30% 98%',
            destructive: '0 60% 40%',
            destructiveForeground: '96 30% 98%',
            border: '96 25% 25%',
            input: '96 25% 25%',
            ring: '96 58% 30%',
        },
        preview: { background: '#141a14', surface: '#1c241c', accent: '#437820', text: '#f2fcf6', textMuted: '#9db88b' },
    },
    {
        id: 'trakt',
        label: 'Trakt',
        description: 'Scrobbler Red',
        emoji: '✔',
        category: 'community',
        palette: {
            background: '0 0% 8%', // Pure Dark/Black
            card: '0 0% 12%',
            cardForeground: '0 0% 98%',
            popover: '0 0% 12%',
            popoverForeground: '0 0% 98%',
            primary: '355 85% 55%', // Classic Trakt Red
            primaryForeground: '0 0% 100%',
            secondary: '0 0% 18%',
            secondaryForeground: '0 0% 98%',
            muted: '0 0% 18%',
            mutedForeground: '0 0% 70%',
            accent: '0 0% 18%',
            accentForeground: '0 0% 98%',
            destructive: '0 63% 31%',
            destructiveForeground: '0 0% 98%',
            border: '0 0% 20%',
            input: '0 0% 20%',
            ring: '355 85% 55%',
        },
        preview: { background: '#141414', surface: '#1f1f1f', accent: '#ed1c24', text: '#fafafa', textMuted: '#a3a3a3' },
    },
    {
        id: 'simkl',
        label: 'Simkl',
        description: 'Tracker deep blue',
        emoji: '🟦',
        category: 'community',
        palette: {
            background: '0 0% 6%', // Black/Dark Gray
            card: '0 0% 10%',
            cardForeground: '225 30% 98%',
            popover: '0 0% 10%',
            popoverForeground: '225 30% 98%',
            primary: '220 80% 55%', // Tech Blue
            primaryForeground: '0 0% 100%',
            secondary: '0 0% 14%',
            secondaryForeground: '225 30% 98%',
            muted: '0 0% 14%',
            mutedForeground: '225 15% 70%',
            accent: '0 0% 14%',
            accentForeground: '225 30% 98%',
            destructive: '0 60% 40%',
            destructiveForeground: '225 30% 98%',
            border: '0 0% 18%',
            input: '0 0% 18%',
            ring: '220 80% 55%',
        },
        preview: { background: '#0a0a0a', surface: '#141414', accent: '#3075e6', text: '#ecf0fa', textMuted: '#9aa5c4' },
    },
    {
        id: 'sonic',
        label: 'Sonicx161',
        description: 'Gotta go fast',
        emoji: '⚡',
        italic: true,
        category: 'community',
        palette: {
            background: '222 84% 10%', // #09225B (Darkened for background)
            card: '222 70% 14%',
            cardForeground: '210 30% 98%',
            popover: '222 70% 14%',
            popoverForeground: '210 30% 98%',
            primary: '195 100% 58%', // #29CDFF (Electric Cyan form logo highlight)
            primaryForeground: '0 0% 10%',
            secondary: '222 50% 20%',
            secondaryForeground: '210 30% 98%',
            muted: '222 50% 20%',
            mutedForeground: '210 30% 65%',
            accent: '222 50% 20%',
            accentForeground: '210 30% 98%',
            destructive: '0 60% 40%',
            destructiveForeground: '210 30% 98%',
            border: '222 50% 20%',
            input: '222 50% 20%',
            ring: '195 100% 58%',
        },
        preview: { background: '#040b1a', surface: '#081329', accent: '#29cdff', text: '#f0fbff', textMuted: '#8da0b3' },
    },

]

interface ThemeContextType {
    theme: Theme
    setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

const STORAGE_KEY = 'stremio-manager-theme'

function applyTheme(palette: ThemePalette) {
    const root = document.documentElement
    root.style.setProperty('--background', palette.background)
    root.style.setProperty('--foreground', palette.cardForeground)
    root.style.setProperty('--card', palette.card)
    root.style.setProperty('--card-foreground', palette.cardForeground)
    root.style.setProperty('--popover', palette.popover)
    root.style.setProperty('--popover-foreground', palette.popoverForeground)
    root.style.setProperty('--primary', palette.primary)
    root.style.setProperty('--primary-foreground', palette.primaryForeground)
    root.style.setProperty('--secondary', palette.secondary)
    root.style.setProperty('--secondary-foreground', palette.secondaryForeground)
    root.style.setProperty('--muted', palette.muted)
    root.style.setProperty('--muted-foreground', palette.mutedForeground)
    root.style.setProperty('--accent', palette.accent)
    root.style.setProperty('--accent-foreground', palette.accentForeground)
    root.style.setProperty('--destructive', palette.destructive)
    root.style.setProperty('--destructive-foreground', palette.destructiveForeground)
    root.style.setProperty('--border', palette.border)
    root.style.setProperty('--input', palette.input)
    root.style.setProperty('--ring', palette.ring)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setThemeState] = useState<Theme>('midnight')

    // Load theme from localStorage on mount
    useEffect(() => {
        const saved = localStorage.getItem(STORAGE_KEY) as Theme | null
        if (saved && THEME_OPTIONS.find(t => t.id === saved)) {
            setThemeState(saved)
        }
    }, [])

    // Apply theme whenever it changes
    useEffect(() => {
        const themeOption = THEME_OPTIONS.find(t => t.id === theme)
        if (themeOption) {
            applyTheme(themeOption.palette)
            document.documentElement.setAttribute('data-theme', theme)

            // Update theme-color meta tag for PWA/mobile status bar
            const metaThemeColor = document.querySelector('meta[name="theme-color"]')
            if (metaThemeColor) {
                metaThemeColor.setAttribute('content', themeOption.preview.background)
            }
        }
    }, [theme])

    const setTheme = (newTheme: Theme) => {
        setThemeState(newTheme)
        localStorage.setItem(STORAGE_KEY, newTheme)
    }

    return (
        <ThemeContext.Provider value={{ theme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    )
}

export function useTheme() {
    const context = useContext(ThemeContext)
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider')
    }
    return context
}
