// Worker entry: runs the deterministic avatar GIF shrink off the main thread so a
// multi-megabyte heal or upload never freezes the UI. Imports the same module as the
// main-thread path statically so the worker bundles to a single file; the output bytes
// are identical and heals still converge across devices.
import { shrinkAvatarDataUrl, shrinkGifBytes } from './avatar-gif.ts'

interface ShrinkRequest {
    id: number
    job: 'shrink-avatar-data-url' | 'shrink-gif'
    dataUrl?: string
    bytes?: ArrayBuffer
    maxDimension?: number
    capBytes?: number
}

addEventListener('message', async (event: MessageEvent<ShrinkRequest>) => {
    const { id, job, dataUrl, bytes, maxDimension, capBytes } = event.data
    try {
        if (job === 'shrink-avatar-data-url') {
            postMessage({ id, ok: true, result: await shrinkAvatarDataUrl(dataUrl as string, maxDimension, capBytes) })
        } else if (job === 'shrink-gif') {
            const shrunk = await shrinkGifBytes(new Uint8Array(bytes as ArrayBuffer), maxDimension, capBytes)
            postMessage({
                id,
                ok: true,
                result: shrunk && { dataUrl: shrunk.dataUrl, size: shrunk.size, width: shrunk.width, height: shrunk.height, frames: shrunk.frames },
            })
        } else {
            postMessage({ id, ok: false, error: 'unknown job' })
        }
    } catch (e) {
        postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
})
