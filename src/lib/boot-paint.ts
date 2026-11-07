// Boot paint: index.html runs a tiny inline script before any CSS or module
// loads and paints the first frame from the last applied theme background,
// persisted here by applyThemeOption.

export const BOOT_BG_STORAGE_KEY = 'aio-boot-bg'

const BOOT_PAINT_STYLE_ID = 'aio-boot-paint'

const HEX_PATTERN = /^#[0-9a-f]{3,8}$/i

export function isValidBootHex(value: string | null | undefined): boolean {
    return typeof value === 'string' && HEX_PATTERN.test(value)
}

// Best effort: storage can throw (private mode, blocked cookies).
export function persistBootBackground(background: string): void {
    if (!isValidBootHex(background)) return
    try {
        localStorage.setItem(BOOT_BG_STORAGE_KEY, background)
    } catch {
        // Next boot falls back to the default paint color.
    }
}

// Let the app's own themed background take over from the pre-mount paint.
// `html body` specificity keeps the boot color winning until this runs.
export function retireBootPaint(): void {
    document.getElementById(BOOT_PAINT_STYLE_ID)?.remove()
    document.documentElement.style.backgroundColor = ''
}
