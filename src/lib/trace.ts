// Client trace sink. Records structured entries into an in-memory ring buffer (always, so a
// devtools `aiomanTrace.dump()` works regardless of flags or a fetch-wrapping extension) and,
// when localStorage.aiomanTrace==='1', also batch-POSTs them to /api/debug/trace for the file log.
// console.* is stripped by esbuild (drop:['console']) even in dev, so dump() returns a string
// the user copies with `copy(aiomanTrace.dump())` instead of streaming to the console.

type TraceData = Record<string, unknown>

interface TraceEntry extends TraceData {
  t: string
  scope: string
  event: string
}

const RING_MAX = 300
const ring: TraceEntry[] = new Array(RING_MAX)
let head = 0
let size = 0

try {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('aiomTrace') === '1') {
    localStorage.setItem('aiomanTrace', '1')
    localStorage.removeItem('aiomTrace')
  }
} catch {}

const isOn = (): boolean => {
  try {
    return localStorage.getItem('aiomanTrace') === '1'
  } catch {
    return false
  }
}

let buffer: TraceEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

// Ship via sendBeacon/XHR, not fetch: a fetch-wrapping browser extension (injectScriptAdjust)
// was aborting the POST. sendBeacon and XHR bypass the window.fetch wrapper entirely.
const send = (entries: TraceEntry[]) => {
  const json = JSON.stringify({ entries })
  try {
    if (navigator.sendBeacon && navigator.sendBeacon('/api/debug/trace', new Blob([json], { type: 'application/json' }))) return
  } catch {}
  try {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/debug/trace', true)
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.send(json)
  } catch {}
}

const flush = () => {
  flushTimer = null
  if (buffer.length === 0) return
  const entries = buffer
  buffer = []
  send(entries)
}

export const traceEnabled = isOn

const URL_IN_TEXT = /\b(?:https?|stremio):\/\/[^\s"'<>]+/gi

const hostOf = (url: string): string => {
  try {
    return new URL(url.replace(/^stremio:/i, 'https:')).host || '[url]'
  } catch {
    return '[url]'
  }
}

// Addon URLs carry config and keys in their path and query: traces keep the host only.
// Keys are redacted like values; anything deeper than the limit or not plain data
// becomes a marker rather than passing through unredacted.
export function redactTraceValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.replace(URL_IN_TEXT, hostOf)
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? '[unsupported]' : value
  if (depth > 8) return '[truncated]'
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return { name: value.name, message: redactTraceValue(value.message) }
  if (Array.isArray(value)) return value.map(v => redactTraceValue(v, depth + 1))
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return '[unsupported]'
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactTraceValue(k) as string, redactTraceValue(v, depth + 1)]))
}

export function trace(scope: string, event: string, data: TraceData = {}) {
  // In dev, always ship to the server file so no flag/console step is needed; in a prod build
  // only ship when the user has explicitly opted in via localStorage.
  const entry: TraceEntry = { t: new Date().toISOString(), scope, event, ...(redactTraceValue(data) as TraceData) }
  ring[(head + size) % RING_MAX] = entry
  if (size < RING_MAX) size++
  else head = (head + 1) % RING_MAX
  if (!import.meta.env?.DEV && !isOn()) return
  buffer.push(entry)
  if (buffer.length >= 15) {
    flush()
    return
  }
  if (!flushTimer) flushTimer = setTimeout(flush, 400)
}

export const briefAddons = (addons: Array<{ manifest?: { id?: string }; transportUrl?: string }> = []) =>
  (Array.isArray(addons) ? addons : []).map(a => ({
    id: a?.manifest?.id || '?',
    host: a?.transportUrl ? hostOf(a.transportUrl) : '',
  }))

const formatEntry = (e: TraceEntry): string => {
  const { t, scope, event, ...rest } = e
  const time = t.slice(11, 23)
  let body = ''
  try {
    body = JSON.stringify(rest)
  } catch {
    body = '[unserializable]'
  }
  return `${time} ${scope}/${event} ${body}`
}

export const dumpTrace = (): string => {
  const entries: string[] = []
  for (let i = 0; i < size; i++) {
    entries.push(formatEntry(ring[(head + i) % RING_MAX]))
  }
  return entries.join('\n')
}

if (typeof window !== 'undefined') {
  (window as unknown as { aiomanTrace?: unknown }).aiomanTrace = {
    on: () => { try { localStorage.setItem('aiomanTrace', '1') } catch {} },
    off: () => { try { localStorage.removeItem('aiomanTrace') } catch {} },
    status: isOn,
    dump: dumpTrace,
    clear: () => { head = 0; size = 0 },
    count: () => size,
  }
  ;(window as unknown as { aiomTrace?: unknown }).aiomTrace = (window as unknown as { aiomanTrace?: unknown }).aiomanTrace
}
