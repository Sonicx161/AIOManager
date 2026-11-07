import { hslToHex, type ThemePalette } from '@/data/theme-core'

function luminanceFor(background: string): number {
    const hex = hslToHex(background)
    const channels = [1, 3, 5].map(offset => {
        const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
        return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
    })
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

export function isLightPalette(palette: ThemePalette): boolean {
    return luminanceFor(palette.background) > 0.18
}

function foregroundFor(background: string): string {
    return luminanceFor(background) < 0.18 ? '0 0% 100%' : '0 0% 0%'
}

// Shared by the app and the isolated editor preview so both use identical tokens.
export function themeVariables(palette: ThemePalette): Record<string, string> {
    const lightSurface = luminanceFor(palette.card) > 0.18
    return {
        '--background': palette.background,
        '--foreground': palette.cardForeground,
        '--card': palette.card,
        '--card-foreground': palette.cardForeground,
        '--popover': palette.card,
        '--popover-foreground': palette.cardForeground,
        '--primary': palette.primary,
        '--primary-foreground': palette.primaryForeground ?? foregroundFor(palette.primary),
        '--secondary': palette.muted,
        '--secondary-foreground': palette.cardForeground,
        '--muted': palette.muted,
        '--muted-foreground': palette.mutedForeground,
        '--accent': palette.muted,
        '--accent-foreground': palette.cardForeground,
        '--destructive': palette.destructive,
        '--destructive-foreground': palette.destructiveForeground ?? foregroundFor(palette.destructive),
        '--border': palette.border,
        '--input': palette.input,
        '--ring': palette.ring,
        // Status and tag labels must remain readable on both light and dark cards.
        '--success': lightSurface ? '142 71% 24%' : '142 71% 45%',
        '--success-foreground': '0 0% 98%',
        '--warning': lightSurface ? '38 92% 28%' : '38 92% 50%',
        '--warning-foreground': lightSurface ? '0 0% 98%' : '0 0% 0%',
        '--info': lightSurface ? '199 89% 29%' : '199 89% 48%',
        '--info-foreground': '0 0% 98%',
        '--tag-color-strength': lightSurface ? '25%' : '100%',
    }
}
