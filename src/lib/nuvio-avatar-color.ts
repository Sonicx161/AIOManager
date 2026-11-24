export const NUVIO_DEFAULT_AVATAR_COLOR = '#6366f1'

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export function nuvioProfileAvatarColor(profile: { avatar_color_hex?: unknown }): string {
    const value = typeof profile.avatar_color_hex === 'string' ? profile.avatar_color_hex.trim() : ''
    return HEX_COLOR.test(value) ? value : NUVIO_DEFAULT_AVATAR_COLOR
}

const channel = (value: number) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

// White unless it would fall under 3:1 on this background; then a near-black letter.
export function nuvioAvatarLetterColor(background: string): string {
    const hex = background.length === 4 ? background.replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3') : background
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    if ([r, g, b].some(Number.isNaN)) return '#ffffff'
    const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    return 1.05 / (luminance + 0.05) < 3 ? '#18181b' : '#ffffff'
}
