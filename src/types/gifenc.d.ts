// gifenc ships no TypeScript declarations; this mirrors the used API surface
// (https://github.com/mattdesl/gifenc). Loaded lazily by src/lib/avatar-gif.ts.
declare module 'gifenc' {
    export type GifPalette = number[][]

    export interface QuantizeOptions {
        format?: 'rgb565' | 'rgb444' | 'rgba4444'
        oneBitAlpha?: boolean | number
        clearAlpha?: boolean
        clearAlphaThreshold?: number
        clearAlphaColor?: number
    }

    export interface WriteFrameOptions {
        palette?: GifPalette
        first?: boolean
        transparent?: boolean
        transparentIndex?: number
        delay?: number
        repeat?: number
        dispose?: number
    }

    export interface GifEncoderInstance {
        writeFrame(index: Uint8Array, width: number, height: number, options?: WriteFrameOptions): void
        finish(): void
        bytes(): Uint8Array
        bytesView(): Uint8Array
        reset(): void
    }

    export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: QuantizeOptions): GifPalette
    export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: GifPalette, format?: 'rgb565' | 'rgb444' | 'rgba4444'): Uint8Array
    export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GifEncoderInstance
}
