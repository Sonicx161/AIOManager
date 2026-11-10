import { normalizeAddonUrl } from './addon-url.ts'

export type RemoveAddonByIndexResult = 'removed' | 'already-gone'

export function resolveRemovalIndex(addons: ReadonlyArray<{ transportUrl: string }>, index: number, expectedTransportUrl?: string): number {
  if (!expectedTransportUrl) return addons[index] ? index : -1
  const expected = normalizeAddonUrl(expectedTransportUrl)
  if (addons[index] && normalizeAddonUrl(addons[index].transportUrl) === expected) return index
  const matches: number[] = []
  addons.forEach((addon, i) => { if (normalizeAddonUrl(addon.transportUrl) === expected) matches.push(i) })
  if (matches.length === 0) return -1
  const atOrBelow = matches.filter(i => i <= index)
  return atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : matches[0]
}
