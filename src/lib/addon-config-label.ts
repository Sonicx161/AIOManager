// Friendly debrid label for an addon config URL (Torrentio-style path config or a
// base64 JSON config). Returns null when no provider can be read. Never returns
// any part of the URL itself.
const PROVIDER_LABELS: Array<[RegExp, string]> = [
  [/real-?debrid/, 'Real-Debrid'],
  [/torbox/, 'TorBox'],
  [/premiumize/, 'Premiumize'],
  [/all-?debrid/, 'AllDebrid'],
  [/debrid-?link/, 'Debrid-Link'],
]

function decodeSafe(part: string): string {
  try { return decodeURIComponent(part) } catch { return part }
}

function base64Text(part: string): string {
  if (part.length < 16 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(part)) return ''
  try {
    const text = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    return /^[\x20-\x7e\s]*$/.test(text) ? text : ''
  } catch {
    return ''
  }
}

export function getAddonConfigLabel(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url.replace(/^stremio:\/\//i, 'https://'))
  } catch {
    return null
  }
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeSafe)
  const haystack = [...parts, ...parts.map(base64Text), decodeSafe(parsed.search)].join('\n').toLowerCase()
  let best: { at: number; label: string } | null = null
  for (const [pattern, label] of PROVIDER_LABELS) {
    const match = new RegExp(`(?:^|[^a-z])${pattern.source}(?=[^a-z]|$)`).exec(haystack)
    if (match && (!best || match.index < best.at)) best = { at: match.index, label }
  }
  return best?.label ?? null
}
