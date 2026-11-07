// Bounds avatar-bound animated GIFs so one picture can never dominate the sync blob.
// Decode runs through gifuct-js, encode through gifenc; both load lazily so neither
// codec enters the boot bundle. The pipeline is pure (no DOM), so the exact same
// routine runs at upload, at heal, and in tests, and its output is deterministic:
// two devices shrinking the same GIF produce identical bytes and converge on sync.
import { bytesToBase64, base64ToBytes } from './base64.ts'
import { AVATAR_FIT_DIMENSION, AVATAR_GIF_CAP_BYTES, decodedDataUrlBytes, isGifBytes, isOversizedAvatarDataUrl } from './avatar-export.ts'

export { AVATAR_FIT_DIMENSION, AVATAR_GIF_CAP_BYTES, AVATAR_EXPORT_CEILING_CHARS, decodedDataUrlBytes, isGifBytes, gifScreenSize, isOversizedAvatarDataUrl, exportAvatarValue } from './avatar-export.ts'

type GifencApi = {
    quantize: (rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: {
        format?: 'rgb565' | 'rgb444' | 'rgba4444'
        oneBitAlpha?: boolean | number
        clearAlpha?: boolean
        clearAlphaThreshold?: number
        clearAlphaColor?: number
    }) => number[][]
    applyPalette: (rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: 'rgb565' | 'rgb444' | 'rgba4444') => Uint8Array
    GIFEncoder: () => {
        writeFrame(index: Uint8Array, width: number, height: number, options?: {
            palette?: number[][]
            first?: boolean
            transparent?: boolean
            transparentIndex?: number
            delay?: number
            repeat?: number
            dispose?: number
        }): void
        finish(): void
        bytes(): Uint8Array
    }
}

export function fitWithin(width: number, height: number, maxDimension: number): { width: number; height: number } {
    if (width <= 0 || height <= 0) return { width: 0, height: 0 }
    if (width <= maxDimension && height <= maxDimension) return { width, height }
    const scale = Math.min(maxDimension / width, maxDimension / height)
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

// Box-filter (area average) downscale with premultiplied alpha; never upscales.
export function resizeRgbaArea(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
    const dst = new Uint8ClampedArray(dw * dh * 4)
    for (let dy = 0; dy < dh; dy++) {
        const sy0 = Math.floor(dy * sh / dh)
        const sy1 = Math.min(sh, Math.max(sy0 + 1, Math.floor((dy + 1) * sh / dh)))
        for (let dx = 0; dx < dw; dx++) {
            const sx0 = Math.floor(dx * sw / dw)
            const sx1 = Math.min(sw, Math.max(sx0 + 1, Math.floor((dx + 1) * sw / dw)))
            let r = 0, g = 0, b = 0, a = 0, n = 0
            for (let sy = sy0; sy < sy1; sy++) {
                for (let sx = sx0; sx < sx1; sx++) {
                    const i = (sy * sw + sx) * 4
                    const al = src[i + 3]
                    r += src[i] * al
                    g += src[i + 1] * al
                    b += src[i + 2] * al
                    a += al
                    n++
                }
            }
            const o = (dy * dw + dx) * 4
            if (a > 0) {
                dst[o] = Math.round(r / a)
                dst[o + 1] = Math.round(g / a)
                dst[o + 2] = Math.round(b / a)
            }
            dst[o + 3] = n > 0 ? Math.round(a / n) : 0
        }
    }
    return dst
}

export interface ShrunkGif {
    bytes: Uint8Array
    dataUrl: string
    size: number
    width: number
    height: number
    frames: number
}

interface PreparedFrame {
    data: Uint8ClampedArray
    delay: number
    width: number
    height: number
}

// Static codec imports: this module is only reachable through lazy paths (the worker
// file, the worker-less fallback chunk), so the codecs still never enter the boot bundle,
// and the worker graph stays a single bundle with no code splitting.
import { parseGIF, decompressFrame } from 'gifuct-js'
import * as gifencModule from 'gifenc'

const gifencApi = gifencModule as unknown as { default?: GifencApi } & GifencApi
const gifenc: GifencApi = typeof gifencApi.GIFEncoder === 'function' ? gifencApi : (gifencApi.default as GifencApi)

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function toGifDataUrl(bytes: Uint8Array): string {
    return `data:image/gif;base64,${bytesToBase64(bytes)}`
}

// Composites the decoded frames at target resolution, honoring GIF disposal, so
// partial patches and optimized GIFs become self-contained full frames.
async function prepareFrames(bytes: Uint8Array, targetWidth: number, targetHeight: number): Promise<PreparedFrame[] | null> {
    const parsed = parseGIF(toArrayBuffer(bytes))
    const width = parsed.lsd?.width || 0
    const height = parsed.lsd?.height || 0
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192) return null
    const canvas = new Uint8ClampedArray(width * height * 4)
    let saved: Uint8ClampedArray | null = null
    let prevRect: { top: number; left: number; width: number; height: number } | null = null
    let prevDisposal = 0
    const prepared: PreparedFrame[] = []
    for (const raw of parsed.frames) {
        if (!raw || !('image' in raw) || !raw.image) continue
        if (prevRect && prevDisposal === 2) {
            for (let y = prevRect.top; y < prevRect.top + prevRect.height && y < height; y++) {
                canvas.fill(0, (y * width + prevRect.left) * 4, (y * width + Math.min(width, prevRect.left + prevRect.width)) * 4)
            }
        } else if (prevRect && prevDisposal === 3 && saved) {
            canvas.set(saved)
        }
        const frame = decompressFrame(raw, parsed.gct, true)
        if (!frame || !frame.patch || !frame.dims) continue
        const patch = frame.patch
        if (!raw.gce?.extras?.transparentColorGiven) {
            // gifuct-js bakes transparentColorIndex into the patch even when the GIF
            // never declared transparency; restore those pixels to opaque.
            for (let i = 3; i < patch.length; i += 4) if (patch[i] === 0) patch[i] = 255
        }
        const { top, left, width: pw, height: ph } = frame.dims
        if (frame.disposalType === 3) saved = canvas.slice()
        for (let y = 0; y < ph; y++) {
            const canvasRow = ((y + top) * width + left) * 4
            const patchRow = y * pw * 4
            for (let x = 0; x < pw * 4; x++) canvas[canvasRow + x] = patch[patchRow + x]
        }
        prevRect = { top, left, width: pw, height: ph }
        prevDisposal = frame.disposalType
        prepared.push({
            data: width === targetWidth && height === targetHeight ? canvas.slice() : resizeRgbaArea(canvas, width, height, targetWidth, targetHeight),
            delay: frame.delay > 0 ? frame.delay : 0,
            width: targetWidth,
            height: targetHeight,
        })
    }
    return prepared.length > 0 ? prepared : null
}

function framesHaveAlpha(frames: PreparedFrame[]): boolean {
    for (const frame of frames) {
        const data = frame.data
        for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true
    }
    return false
}

async function encodeGif(
    gifenc: GifencApi,
    frames: PreparedFrame[],
    width: number,
    height: number,
    maxColors: number,
    stride: number,
    hasAlpha: boolean,
): Promise<Uint8Array> {
    const gif = gifenc.GIFEncoder()
    const format = hasAlpha ? 'rgba4444' : 'rgb565'
    let pendingDelay = 0
    for (let i = 0; i < frames.length; i++) {
        const isKept = i % stride === 0
        if (!isKept) {
            pendingDelay += frames[i].delay
            continue
        }
        const source = frames[i]
        const frameData = source.width === width && source.height === height
            ? source.data
            : resizeRgbaArea(source.data, source.width, source.height, width, height)
        const palette = gifenc.quantize(frameData, maxColors, {
            format,
            oneBitAlpha: hasAlpha || undefined,
        })
        const index = gifenc.applyPalette(frameData, palette, format)
        const transparentIndex = hasAlpha ? palette.findIndex(color => color.length > 3 && color[3] === 0) : -1
        gif.writeFrame(index, width, height, {
            palette,
            delay: Math.max(20, source.delay + pendingDelay),
            transparent: transparentIndex >= 0,
            transparentIndex: transparentIndex >= 0 ? transparentIndex : 0,
            dispose: transparentIndex >= 0 ? 2 : undefined,
        })
        pendingDelay = 0
    }
    gif.finish()
    return gif.bytes()
}

// Deterministic reduction schedule: palette first, then frames, then dimensions.
function reductionAttempts(frameCount: number): Array<{ colors: number; stride: number; scale: number }> {
    const strideMax = Math.max(1, Math.floor(frameCount / 2))
    const attempts: Array<{ colors: number; stride: number; scale: number }> = []
    for (const colors of [256, 128, 64, 32]) attempts.push({ colors, stride: 1, scale: 1 })
    for (const stride of [2, 4, 8]) {
        const capped = Math.min(stride, strideMax)
        if (!attempts.some(a => a.stride === capped && a.scale === 1)) attempts.push({ colors: 32, stride: capped, scale: 1 })
    }
    for (const scale of [0.8, 0.6, 0.45]) attempts.push({ colors: 32, stride: strideMax, scale })
    for (const scale of [0.6, 0.45, 0.35]) attempts.push({ colors: 16, stride: strideMax, scale })
    return attempts
}

export async function shrinkGifBytes(
    source: Uint8Array,
    maxDimension: number = AVATAR_FIT_DIMENSION,
    capBytes: number = AVATAR_GIF_CAP_BYTES,
): Promise<ShrunkGif | null> {
    if (!isGifBytes(source)) return null
    try {
        const parsed = parseGIF(toArrayBuffer(source))
        const width = parsed.lsd?.width || 0
        const height = parsed.lsd?.height || 0
        const frameCount = (parsed.frames || []).filter(f => f && 'image' in f && f.image).length
        if (frameCount < 2) return null
        const target = fitWithin(width, height, maxDimension)
        if (target.width < 1 || target.height < 1) return null
        if (target.width === width && target.height === height && source.length <= capBytes) {
            return { bytes: source, dataUrl: toGifDataUrl(source), size: source.length, width, height, frames: frameCount }
        }
        const prepared = await prepareFrames(source, target.width, target.height)
        if (!prepared || prepared.length < 2) return null
        const hasAlpha = framesHaveAlpha(prepared)
        let result: { bytes: Uint8Array; width: number; height: number; frames: number } | null = null
        for (const attempt of reductionAttempts(prepared.length)) {
            const attemptWidth = Math.max(48, Math.round(target.width * attempt.scale))
            const attemptHeight = Math.max(48, Math.round(target.height * attempt.scale))
            const bytes = await encodeGif(gifenc, prepared, attemptWidth, attemptHeight, attempt.colors, attempt.stride, hasAlpha)
            const keptFrames = Math.ceil(prepared.length / attempt.stride)
            result = { bytes, width: attemptWidth, height: attemptHeight, frames: keptFrames }
            if (bytes.length <= capBytes) break
        }
        if (!result) return null
        return {
            bytes: result.bytes,
            dataUrl: toGifDataUrl(result.bytes),
            size: result.bytes.length,
            width: result.width,
            height: result.height,
            frames: result.frames,
        }
    } catch {
        return null
    }
}

// Static (non-animated) oversized avatars shrink through the browser canvas, mirroring
// the static upload path; returns null when no DOM is available or nothing improved.
async function shrinkStaticViaCanvas(dataUrl: string, maxDimension: number): Promise<string | null> {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return null
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image()
            el.onload = () => resolve(el)
            el.onerror = () => reject(new Error('image load failed'))
            el.src = dataUrl
        })
        const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, maxDimension)
        if (width < 1 || height < 1) return null
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) return null
        ctx.drawImage(img, 0, 0, width, height)
        const out = canvas.toDataURL('image/webp', 0.85)
        const outBytes = decodedDataUrlBytes(out)
        const inBytes = decodedDataUrlBytes(dataUrl)
        return outBytes !== null && inBytes !== null && outBytes < inBytes ? out : null
    } catch {
        return null
    }
}

// Worker-safe static path: a module worker has no document/Image, but OffscreenCanvas
// and createImageBitmap exist there, so an oversized static PNG/JPEG/WebP still heals
// off the main thread. Same fit bounds and WebP quality as the canvas path.
async function shrinkStaticViaOffscreen(dataUrl: string, maxDimension: number): Promise<string | null> {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return null
    try {
        const comma = dataUrl.indexOf(',')
        if (comma < 0) return null
        const meta = dataUrl.slice(0, comma)
        const mimeEnd = meta.indexOf(';')
        const mime = meta.slice(5, mimeEnd < 0 ? undefined : mimeEnd) || 'image/png'
        const bytes = base64ToBytes(dataUrl.slice(comma + 1))
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }))
        try {
            const { width, height } = fitWithin(bitmap.width, bitmap.height, maxDimension)
            if (width < 1 || height < 1) return null
            const canvas = new OffscreenCanvas(width, height)
            const ctx = canvas.getContext('2d')
            if (!ctx) return null
            ctx.drawImage(bitmap, 0, 0, width, height)
            const outBlob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })
            const outBytes = new Uint8Array(await outBlob.arrayBuffer())
            const inBytes = decodedDataUrlBytes(dataUrl)
            if (inBytes === null || outBytes.length >= inBytes) return null
            return `data:${outBlob.type};base64,${bytesToBase64(outBytes)}`
        } finally {
            bitmap.close()
        }
    } catch {
        return null
    }
}

async function shrinkStatic(dataUrl: string, maxDimension: number): Promise<string | null> {
    if (typeof document !== 'undefined' && typeof Image !== 'undefined') return shrinkStaticViaCanvas(dataUrl, maxDimension)
    return shrinkStaticViaOffscreen(dataUrl, maxDimension)
}

// Heals one stored avatar data URL: oversized GIFs shrink through the same
// deterministic routine; oversized static images fall back to the canvas path.
export async function shrinkAvatarDataUrl(
    dataUrl: string,
    maxDimension: number = AVATAR_FIT_DIMENSION,
    capBytes: number = AVATAR_GIF_CAP_BYTES,
): Promise<string | null> {
    if (!isOversizedAvatarDataUrl(dataUrl)) return null
    const comma = dataUrl.indexOf(',')
    if (comma < 0) return null
    try {
        const bytes = base64ToBytes(dataUrl.slice(comma + 1))
        if (isGifBytes(bytes)) {
            const shrunk = await shrinkGifBytes(bytes, maxDimension, capBytes)
            if (shrunk && shrunk.size <= capBytes && shrunk.size < bytes.length) return shrunk.dataUrl
            return null
        }
    } catch {
        // fall through to the static path
    }
    return shrinkStatic(dataUrl, maxDimension)
}
