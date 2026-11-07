import { AVATAR_GIF_CAP_BYTES, gifScreenSize } from './avatar-export.ts'
import { shrinkGifBytesOffMain } from './avatar-gif-worker-client.ts'

const MAGIC_BYTES: Record<string, number[]> = {
    'image/jpeg': [0xFF, 0xD8, 0xFF],
    'image/png': [0x89, 0x50, 0x4E, 0x47],
    'image/gif': [0x47, 0x49, 0x46, 0x38],
    'image/webp': [0x52, 0x49, 0x46, 0x46],
}

const MAX_RAW_SIZE = 8 * 1024 * 1024
const MAX_GIF_SIZE = 5 * 1024 * 1024

export interface ProcessImageOptions {
    maxDimension: number
    square?: boolean
    quality?: number
}

export interface ProcessedImage {
    dataUrl: string
    size: number
    mime: string
}

function checkMagicBytes(buf: ArrayBuffer): string | null {
    const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, 12))
    for (const [mime, signature] of Object.entries(MAGIC_BYTES)) {
        if (signature.every((b, i) => bytes[i] === b)) return mime
    }
    return null
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export async function processImageFile(file: File, options: ProcessImageOptions): Promise<ProcessedImage> {
    if (file.size > MAX_RAW_SIZE) {
        throw new Error(`File too large. Max ${formatFileSize(MAX_RAW_SIZE)}, got ${formatFileSize(file.size)}.`)
    }

    const buf = await file.arrayBuffer()
    const detectedMime = checkMagicBytes(buf)

    if (!detectedMime) {
        throw new Error('Unsupported file type. Use JPEG, PNG, WebP, or GIF.')
    }

    if (detectedMime === 'image/gif') {
        if (file.size > MAX_GIF_SIZE) {
            throw new Error(`GIF too large. Max ${formatFileSize(MAX_GIF_SIZE)}, got ${formatFileSize(file.size)}.`)
        }
        // Compliant GIFs (already avatar-sized and under the cap) pass through verbatim
        // without a worker round trip, matching the shrinker's own fast path.
        const screen = gifScreenSize(new Uint8Array(buf))
        if (screen && screen.width <= options.maxDimension && screen.height <= options.maxDimension && buf.byteLength <= AVATAR_GIF_CAP_BYTES) {
            const dataUrl = await fileToDataUrl(file)
            return { dataUrl, size: file.size, mime: 'image/gif' }
        }
        // Animated GIFs keep their animation, shrunk off the main thread; static or
        // undecodable GIFs come back null and take the static paths below.
        const animated = await shrinkGifBytesOffMain(new Uint8Array(buf), options.maxDimension)
        if (animated) {
            return { dataUrl: animated.dataUrl, size: animated.size, mime: 'image/gif' }
        }
        if (buf.byteLength <= AVATAR_GIF_CAP_BYTES) {
            const dataUrl = await fileToDataUrl(file)
            return { dataUrl, size: file.size, mime: 'image/gif' }
        }
    }

    const img = await loadImage(dataUrlFromArrayBuffer(buf, detectedMime))
    const { canvas, mime } = drawToCanvas(img, options)
    const quality = options.quality ?? 0.85
    const dataUrl = canvas.toDataURL('image/webp', quality)

    const estimatedSize = Math.ceil((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)
    return { dataUrl, size: estimatedSize, mime }
}

function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('Failed to read file.'))
        reader.readAsDataURL(file)
    })
}

function dataUrlFromArrayBuffer(buf: ArrayBuffer, mime: string): string {
    const bytes = new Uint8Array(buf)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i])
    }
    return `data:${mime};base64,${btoa(binary)}`
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('Failed to load image.'))
        img.src = src
    })
}

function drawToCanvas(img: HTMLImageElement, options: ProcessImageOptions): { canvas: HTMLCanvasElement; mime: string } {
    const { maxDimension, square } = options

    let sourceX = 0
    let sourceY = 0
    let sourceW = img.naturalWidth
    let sourceH = img.naturalHeight

    if (square) {
        const minDim = Math.min(sourceW, sourceH)
        sourceX = (sourceW - minDim) / 2
        sourceY = (sourceH - minDim) / 2
        sourceW = minDim
        sourceH = minDim
    }

    let destW = maxDimension
    let destH = maxDimension

    if (!square) {
        const scale = Math.min(maxDimension / sourceW, maxDimension / sourceH, 1)
        destW = Math.round(sourceW * scale)
        destH = Math.round(sourceH * scale)
    }

    const canvas = document.createElement('canvas')
    canvas.width = destW
    canvas.height = destH
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, sourceX, sourceY, sourceW, sourceH, 0, 0, destW, destH)

    return { canvas, mime: 'image/webp' }
}
