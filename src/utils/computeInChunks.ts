/**
 * Iterates through items in chunks, yielding control back to the browser 
 * between chunks to keep the UI responsive.
 */
export async function computeInChunks<T, R>(
    items: T[],
    processor: (chunk: T[], accumulator: R) => R,
    initialAccumulator: R,
    chunkSize = 500
): Promise<R> {
    let accumulator = initialAccumulator
    let index = 0

    const nextChunk = (): Promise<void> => {
        return new Promise((resolve) => {
            const work = () => {
                const chunk = items.slice(index, index + chunkSize)
                accumulator = processor(chunk, accumulator)
                index += chunkSize

                if (index < items.length) {
                    // Yield to browser
                    if ('requestIdleCallback' in window) {
                        (window as any).requestIdleCallback(() => resolve(nextChunk()), { timeout: 100 })
                    } else {
                        setTimeout(() => resolve(nextChunk()), 0)
                    }
                } else {
                    resolve()
                }
            }
            work()
        })
    }

    await nextChunk()
    return accumulator
}
