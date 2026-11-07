// Artwork colour: the detail sheet chrome takes the poster's dominant colour,
// muted into the card colour with the title contrast held at 4.5:1 or better
// (Cider's Emotion Engine subjectColor, adapted). Sampling reuses the small
// canvas approach of components/ui/addon-icon.tsx; hosts without CORS headers
// (images.metahub.space) cannot be read and fall back to the neutral card chrome.
const SAMPLE_SIZE = 24

export interface Rgb {
    r: number
    g: number
    b: number
}

let sharedCanvas: HTMLCanvasElement | null = null
let sharedContext: CanvasRenderingContext2D | null = null

function sharedCtx(): CanvasRenderingContext2D | null {
    if (typeof document === 'undefined') return null
    if (!sharedCanvas) {
        sharedCanvas = document.createElement('canvas')
        sharedCanvas.width = SAMPLE_SIZE
        sharedCanvas.height = SAMPLE_SIZE
    }
    sharedContext ??= sharedCanvas.getContext('2d', { willReadFrequently: true })
    return sharedContext
}

const dominantCache = new Map<string, Rgb | null>()

/** Saturation-weighted average of readable pixels; null when the host sends no CORS header. */
export function dominantColorFromImageUrl(url: string): Promise<Rgb | null> {
    if (dominantCache.has(url)) return Promise.resolve(dominantCache.get(url) ?? null)
    return new Promise(resolve => {
        if (typeof Image === 'undefined') { dominantCache.set(url, null); resolve(null); return }
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.decoding = 'async'
        const done = (value: Rgb | null) => { dominantCache.set(url, value); resolve(value) }
        img.onerror = () => done(null)
        img.onload = () => {
            const ctx = sharedCtx()
            if (!ctx) { done(null); return }
            ctx.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
            try {
                ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
            } catch {
                done(null)
                return
            }
            let data: Uint8ClampedArray
            try {
                data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
            } catch {
                // Canvas tainted: no CORS header on this host.
                done(null)
                return
            }
            let r = 0, g = 0, b = 0, weight = 0
            for (let i = 0; i < data.length; i += 4) {
                const alpha = data[i + 3]
                if (alpha < 24) continue
                const R = data[i], G = data[i + 1], B = data[i + 2]
                if (R < 40 && G < 40 && B < 40) continue
                if (R > 210 && G > 210 && B > 210) continue
                const max = Math.max(R, G, B), min = Math.min(R, G, B)
                const sat = (max - min) / 255
                const lum = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255
                const w = sat * (1 - Math.abs(lum - 0.5)) + 0.05
                r += R * w; g += G * w; b += B * w; weight += w
            }
            if (weight === 0) { done(null); return }
            done({ r: Math.round(r / weight), g: Math.round(g / weight), b: Math.round(b / weight) })
        }
        img.src = url
    })
}

export function luminance({ r, g, b }: Rgb): number {
    const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
    const l1 = luminance(a), l2 = luminance(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
    return {
        r: Math.round(a.r + (b.r - a.r) * t),
        g: Math.round(a.g + (b.g - a.g) * t),
        b: Math.round(a.b + (b.b - a.b) * t),
    }
}

export function rgbCss({ r, g, b }: Rgb): string {
    return `rgb(${r} ${g} ${b})`
}

/** Current card/foreground colours as RGB, from the active theme's tokens. */
export function themeSurfaceColors(): { card: Rgb; fg: Rgb } {
    const fallback = { card: { r: 15, g: 15, b: 15 }, fg: { r: 250, g: 250, b: 250 } }
    if (typeof document === 'undefined') return fallback
    const readHslVar = (name: string): Rgb | null => {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
        const parts = raw.split(' ').map(v => Number.parseFloat(v))
        if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null
        const [h, s, l] = parts
        const sat = s / 100, lig = l / 100
        const k = (n: number) => (n + h / 30) % 12
        const a = sat * Math.min(lig, 1 - lig)
        const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
        return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) }
    }
    return { card: readHslVar('--card') ?? fallback.card, fg: readHslVar('--foreground') ?? fallback.fg }
}

export interface ArtworkChrome {
    dominant: Rgb
    /** Poster colour muted into the card; the glass bar tint derives from it. */
    bar: Rgb
    barShare: number
    /** Composite of the bar mix and the title colour after mixing, as fed to the tint. */
    titleContrast: number
    pill: Rgb
    pillForeground: Rgb
    pillContrast: number
    accent: Rgb
}

const BAR_SHARES = [0.32, 0.28, 0.24, 0.20, 0.16, 0.12, 0.08, 0] as const

/** The mockup's derivation: mute the dominant colour into the card until the title keeps 4.5:1. */
export function deriveArtworkChrome(dominant: Rgb, card: Rgb, fg: Rgb): ArtworkChrome {
    let bar = card
    let share = 0
    let ratio = contrastRatio(fg, card)
    for (const candidate of BAR_SHARES) {
        const mixed = mix(card, dominant, candidate)
        const r = contrastRatio(fg, mixed)
        if (r >= 4.5) { bar = mixed; share = candidate; ratio = r; break }
    }
    let pill = mix(dominant, { r: 244, g: 244, b: 244 }, 0.45)
    let pillFg: Rgb = { r: 10, g: 10, b: 10 }
    let pillRatio = contrastRatio(pillFg, pill)
    if (pillRatio < 4.5) {
        pill = mix(dominant, { r: 26, g: 26, b: 26 }, 0.5)
        pillFg = { r: 250, g: 250, b: 250 }
        pillRatio = contrastRatio(pillFg, pill)
        if (pillRatio < 4.5) {
            pill = { r: 250, g: 250, b: 250 }
            pillFg = { r: 10, g: 10, b: 10 }
            pillRatio = contrastRatio(pillFg, pill)
        }
    }
    return { dominant, bar, barShare: share, titleContrast: ratio, pill, pillForeground: pillFg, pillContrast: pillRatio, accent: mix(dominant, fg, 0.35) }
}
