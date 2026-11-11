import { normalizeAddonUrl } from './addon-url.ts'

export interface StabilizationEntry {
  failures: number
  successes: number
  latencyMs: number | null
}

type RawEntry = number | { failures?: number; successes?: number; latencyMs?: number | null }

function normalizeEntry(entry: RawEntry): StabilizationEntry {
  if (typeof entry === 'number') {
    return { failures: entry < 0 ? Math.abs(entry) : 0, successes: entry > 0 ? entry : 0, latencyMs: null }
  }
  const failures = Number(entry.failures)
  const successes = Number(entry.successes)
  return {
    failures: Number.isFinite(failures) ? failures : 0,
    successes: Number.isFinite(successes) ? successes : 0,
    latencyMs: typeof entry.latencyMs === 'number' && Number.isFinite(entry.latencyMs) ? entry.latencyMs : null,
  }
}

/** The server's per-addon check counters for one chain URL, matched the way the rule card matches them. */
export function readStabilization(stabilization: Record<string, RawEntry> | undefined, url: string | undefined): StabilizationEntry {
  const empty = { failures: 0, successes: 0, latencyMs: null }
  if (!url || !stabilization) return empty
  const normalized = normalizeAddonUrl(url)
  for (const key of [url, url.toLowerCase(), normalized]) {
    const entry = stabilization[key]
    if (entry !== undefined) return normalizeEntry(entry)
  }
  for (const [key, entry] of Object.entries(stabilization)) {
    if (normalizeAddonUrl(key) === normalized) return normalizeEntry(entry)
  }
  return empty
}
