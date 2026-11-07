// Main-thread client for the avatar GIF worker (src/lib/avatar-gif.worker.ts). Spawns a
// module worker per job and terminates it after use, so neither the worker nor its codec
// chunks load until a shrink actually runs. Where workers are unavailable (tests, or a
// worker that fails to load) it falls back to the identical main-thread pipeline.
import type { ShrunkGif } from './avatar-gif.ts'

interface WorkerResponse {
    id: number
    ok: boolean
    result?: unknown
    error?: string
}

let nextJobId = 1

async function runJob<T>(message: Record<string, unknown>, transfer?: Transferable[]): Promise<T> {
    if (typeof Worker === 'undefined') throw new Error('workers unavailable')
    const worker = new Worker(new URL('./avatar-gif.worker.ts', import.meta.url), { type: 'module' })
    const id = nextJobId++
    try {
        return await new Promise<T>((resolve, reject) => {
            const cleanup = () => {
                worker.removeEventListener('message', onMessage)
                worker.removeEventListener('error', onError)
                worker.removeEventListener('messageerror', onError)
            }
            const onMessage = (event: MessageEvent<WorkerResponse>) => {
                if (event.data?.id !== id) return
                cleanup()
                if (!event.data.ok) reject(new Error(event.data.error || 'avatar worker job failed'))
                else resolve(event.data.result as T)
            }
            const onError = () => {
                cleanup()
                reject(new Error('avatar worker failed'))
            }
            worker.addEventListener('message', onMessage)
            worker.addEventListener('error', onError)
            worker.addEventListener('messageerror', onError)
            worker.postMessage({ id, ...message }, transfer ?? [])
        })
    } finally {
        worker.terminate()
    }
}

export async function shrinkAvatarDataUrlOffMain(
    dataUrl: string,
    maxDimension?: number,
    capBytes?: number,
): Promise<string | null> {
    try {
        return await runJob<string | null>({ job: 'shrink-avatar-data-url', dataUrl, maxDimension, capBytes })
    } catch {
        const { shrinkAvatarDataUrl } = await import('./avatar-gif.ts')
        return shrinkAvatarDataUrl(dataUrl, maxDimension, capBytes)
    }
}

export async function shrinkGifBytesOffMain(
    bytes: Uint8Array,
    maxDimension?: number,
    capBytes?: number,
): Promise<ShrunkGif | null> {
    // Slice a copy: the buffer is transferred to the worker, the caller keeps its view.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    try {
        return await runJob<ShrunkGif | null>({ job: 'shrink-gif', bytes: buffer, maxDimension, capBytes }, [buffer])
    } catch {
        const { shrinkGifBytes } = await import('./avatar-gif.ts')
        return shrinkGifBytes(bytes, maxDimension, capBytes)
    }
}
