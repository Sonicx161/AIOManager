export interface StremioMetaBatchEntry {
  authKey: string
  accountContext?: string
}

export type StremioMetaBatchRow = Array<[string, number]>
export type StremioMetaBatchResponse = { result?: unknown }

const CHUNK_SIZE = 50
const CHUNK_CONCURRENCY = 2

export function isValidStremioMetaRow(row: unknown): row is StremioMetaBatchRow {
  if (!Array.isArray(row)) return false
  const ids = new Set<string>()
  return row.every(item => {
    if (!Array.isArray(item) || item.length !== 2) return false
    const [id, mtime] = item
    if (typeof id !== 'string' || id.length === 0 || ids.has(id)) return false
    if (typeof mtime !== 'number' || !Number.isSafeInteger(mtime) || mtime < 0) return false
    ids.add(id)
    return true
  })
}

export const validateStremioMetaRows = (rows: unknown): StremioMetaBatchRow | null =>
  isValidStremioMetaRow(rows) ? rows : null

/**
 * Fetch bounded metadata chunks with a small amount of overlap.
 * Results remain aligned to the input entries; failed or malformed chunks
 * retain null slots so callers can use their per-account fallback.
 */
export async function fetchStremioMetaBatch(
  entries: StremioMetaBatchEntry[],
  post: (chunk: StremioMetaBatchEntry[], chunkIndex: number) => Promise<StremioMetaBatchResponse>,
): Promise<Array<StremioMetaBatchRow | null>> {
  const results: Array<StremioMetaBatchRow | null> = new Array(entries.length).fill(null)
  const chunks = Array.from({ length: Math.ceil(entries.length / CHUNK_SIZE) }, (_, chunkIndex) => ({
    chunkIndex,
    offset: chunkIndex * CHUNK_SIZE,
    entries: entries.slice(chunkIndex * CHUNK_SIZE, (chunkIndex + 1) * CHUNK_SIZE),
  }))
  let nextChunk = 0

  const worker = async () => {
    while (nextChunk < chunks.length) {
      const work = chunks[nextChunk++]
      if (!work) return
      try {
        const result = (await post(work.entries, work.chunkIndex)).result
        if (!Array.isArray(result) || result.length !== work.entries.length) continue
        result.forEach((row, index) => {
          if (isValidStremioMetaRow(row)) results[work.offset + index] = row
        })
      } catch {
        // Failed slots remain null and use the existing per-account fallback.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, worker))
  return results
}
