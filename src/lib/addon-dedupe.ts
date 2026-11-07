import type { AddonDescriptor } from '@/types/addon'
import { normalizeAddonUrl } from './addon-url.ts'
import { getAddonInstanceKey } from './addon-instance-identity.ts'

export function getAddonUrlKey(url: string): string {
  return normalizeAddonUrl(url)
}

function hasKeys(value: Record<string, unknown> | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0)
}

function withoutUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {}
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

function mergeDuplicateAddon(existing: AddonDescriptor, incoming: AddonDescriptor): AddonDescriptor {
  // Intentional asymmetry: existing flags preserve local controls such as
  // protected/disabled, while incoming metadata can refresh deployment labels.
  const flags = {
    ...(incoming.flags || {}),
    ...(existing.flags || {}),
  }
  const metadata = {
    ...withoutUndefined(existing.metadata),
    ...withoutUndefined(incoming.metadata),
  }

  return {
    ...existing,
    ...incoming,
    transportUrl: incoming.transportUrl || existing.transportUrl,
    manifest: incoming.manifest || existing.manifest,
    flags: hasKeys(flags) ? flags : undefined,
    metadata: hasKeys(metadata) ? metadata : undefined,
    catalogOverrides: incoming.catalogOverrides || existing.catalogOverrides,
    note: incoming.note ?? existing.note,
    syncToLibrary: incoming.syncToLibrary ?? existing.syncToLibrary,
  }
}

// Same-instance self-heal: two entries of one logical instance (an old config
// URL plus the new one a sync appended) collapse onto the FIRST position with
// the LAST (newest) transportUrl; enabled/protected are OR-ed so a live or
// protected copy never gets disabled by the merge.
function mergeInstanceDuplicate(existing: AddonDescriptor, incoming: AddonDescriptor): AddonDescriptor {
  // enabled follows app convention (undefined = enabled): only both-explicitly-
  // false collapses to false; protected is opt-in so a plain Boolean OR is exact.
  const enabled = existing.flags?.enabled === false && incoming.flags?.enabled === false
    ? false
    : existing.flags?.enabled === true || incoming.flags?.enabled === true ? true : undefined

  const flags = (existing.flags || incoming.flags)
    ? {
        ...(incoming.flags || {}),
        ...(existing.flags || {}),
        enabled,
        protected: Boolean(existing.flags?.protected) || Boolean(incoming.flags?.protected),
      }
    : undefined

  return {
    ...mergeDuplicateAddon(existing, incoming),
    flags,
  }
}

function collapseInstanceDuplicates(addons: AddonDescriptor[]): AddonDescriptor[] {
  const result: AddonDescriptor[] = []
  const indexByInstanceKey = new Map<string, number>()

  for (const addon of addons) {
    const key = getAddonInstanceKey(addon)
    if (!key) {
      result.push(addon)
      continue
    }

    const existingIndex = indexByInstanceKey.get(key)
    if (existingIndex === undefined) {
      indexByInstanceKey.set(key, result.length)
      result.push(addon)
      continue
    }

    result[existingIndex] = mergeInstanceDuplicate(result[existingIndex], addon)
  }

  return result
}

// Identical normalized URLs only. Collection writes use this (never the instance
// fold), so copies kept apart on purpose survive every later write.
export function dedupeAddonsByUrl(addons: AddonDescriptor[]): AddonDescriptor[] {
  const result: AddonDescriptor[] = []
  const indexByUrl = new Map<string, number>()

  for (const addon of addons) {
    const key = getAddonUrlKey(addon.transportUrl)
    if (!key) {
      result.push(addon)
      continue
    }

    const existingIndex = indexByUrl.get(key)
    if (existingIndex === undefined) {
      indexByUrl.set(key, result.length)
      result.push(addon)
      continue
    }

    result[existingIndex] = mergeDuplicateAddon(result[existingIndex], addon)
  }

  return result
}

// Where a URL install lands, decided before any dedupe: the entry at the same URL, else
// the sole pre-existing copy of its instance that no earlier install in this batch took
// (a config-URL re-save replaces it), else -1 to append.
export function findInstallSlot(addons: AddonDescriptor[], incoming: AddonDescriptor, preExisting: number, taken: ReadonlySet<number>): number {
  const urlKey = getAddonUrlKey(incoming.transportUrl)
  const exact = addons.findIndex(addon => getAddonUrlKey(addon.transportUrl) === urlKey)
  if (exact >= 0) return exact
  const instanceKey = getAddonInstanceKey(incoming)
  const same: number[] = []
  for (let i = 0; i < preExisting; i++) {
    if (getAddonInstanceKey(addons[i]) === instanceKey) same.push(i)
  }
  return same.length === 1 && !taken.has(same[0]) ? same[0] : -1
}

// Read and display dedupe: URL duplicates, then same-instance copies folded into one.
export function dedupeAddonsByTransportUrl(addons: AddonDescriptor[]): AddonDescriptor[] {
  return collapseInstanceDuplicates(dedupeAddonsByUrl(addons))
}
