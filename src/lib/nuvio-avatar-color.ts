export const NUVIO_DEFAULT_AVATAR_COLOR = '#6366f1'

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export function nuvioProfileAvatarColor(profile: { avatar_color_hex?: unknown }): string {
    const value = typeof profile.avatar_color_hex === 'string' ? profile.avatar_color_hex.trim() : ''
    return HEX_COLOR.test(value) ? value : NUVIO_DEFAULT_AVATAR_COLOR
}
