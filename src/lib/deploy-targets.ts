import type { AddonDescriptor } from '@/types/addon'
import type { SavedAddon } from '@/types/saved-addon'
import { normalizeAddonUrl } from './addon-url.ts'
import { getAddonIdentity } from './addon-instance-identity.ts'

type SavedLike = Pick<SavedAddon, 'id' | 'installUrl' | 'manifest'>

// append: add as a new entry. exact/replace: write over current[index]. ask: the
// account holds one older copy of the same unanchored addon with a different
// config, so the user decides between replacing current[index] and keeping both.
export type DeployTarget = { kind: 'append' } | { kind: 'exact' | 'replace' | 'ask'; index: number }

// (a) an exact URL match updates in place; (b) else the sole account entry sharing
// the config-less identity is the candidate: the same instance replaces in place
// unless another library entry owns it, an unanchored different config asks (never
// when protected). Claimed entries and candidates wanted by two saved addons are
// never written, so bulk deploys never depend on order.
export function planDeployTargets(
  currentAddons: Pick<AddonDescriptor, 'transportUrl' | 'manifest' | 'flags'>[],
  savedAddons: SavedLike[],
  library: SavedLike[] = savedAddons,
): DeployTarget[] {
  const byUrl = new Map<string, number[]>()
  const byConfigless = new Map<string, number[]>()
  const current = currentAddons.map((addon, index) => {
    const url = normalizeAddonUrl(addon.transportUrl)
    const urlBucket = byUrl.get(url)
    if (urlBucket) urlBucket.push(index)
    else byUrl.set(url, [index])
    const identity = getAddonIdentity(addon)
    const keyBucket = byConfigless.get(identity.configless)
    if (keyBucket) keyBucket.push(index)
    else byConfigless.set(identity.configless, [index])
    return identity
  })

  const targets: DeployTarget[] = savedAddons.map(() => ({ kind: 'append' }))
  const claimed = new Set<number>()
  savedAddons.forEach((saved, savedIndex) => {
    const index = byUrl.get(normalizeAddonUrl(saved.installUrl))?.find((i) => !claimed.has(i))
    if (index === undefined) return
    claimed.add(index)
    targets[savedIndex] = { kind: 'exact', index }
  })

  const ownersByInstance = new Map<string, Set<string>>()
  for (const entry of [...library, ...savedAddons]) {
    const key = getAddonIdentity({ transportUrl: entry.installUrl, manifest: entry.manifest }).instance
    const owners = ownersByInstance.get(key)
    if (owners) owners.add(entry.id)
    else ownersByInstance.set(key, new Set([entry.id]))
  }

  const wantedBy = new Map<number, Array<{ savedIndex: number; kind: 'replace' | 'ask' }>>()
  savedAddons.forEach((saved, savedIndex) => {
    if (targets[savedIndex].kind !== 'append') return
    const identity = getAddonIdentity({ transportUrl: saved.installUrl, manifest: saved.manifest })
    const sharing = byConfigless.get(identity.configless)
    if (!sharing || sharing.length !== 1 || claimed.has(sharing[0])) return
    const candidate = sharing[0]
    let kind: 'replace' | 'ask'
    if (current[candidate].instance === identity.instance) {
      // Never silently overwrite a copy another library entry owns; asking leaves it to the user.
      const owners = ownersByInstance.get(current[candidate].instance)
      if (owners && [...owners].some((id) => id !== saved.id)) return
      kind = 'replace'
    } else if (identity.unanchoredConfig && !currentAddons[candidate].flags?.protected) kind = 'ask'
    else return
    const wanting = wantedBy.get(candidate)
    if (wanting) wanting.push({ savedIndex, kind })
    else wantedBy.set(candidate, [{ savedIndex, kind }])
  })
  for (const [index, wanting] of wantedBy) {
    if (wanting.length === 1) targets[wanting[0].savedIndex] = { kind: wanting[0].kind, index }
  }
  return targets
}

// Per-account deploy estimate from the same planner the merge uses.
export function summarizeDeployTargets(
  currentAddons: Pick<AddonDescriptor, 'transportUrl' | 'manifest' | 'flags'>[],
  savedAddons: SavedLike[],
  library: SavedLike[],
  allowProtected: boolean,
): { installs: number; refreshes: number; asks: number; protectedSkips: number } {
  const counts = { installs: 0, refreshes: 0, asks: 0, protectedSkips: 0 }
  for (const target of planDeployTargets(currentAddons, savedAddons, library)) {
    if (target.kind === 'append') counts.installs += 1
    else if (target.kind === 'ask') counts.asks += 1
    else if (currentAddons[target.index].flags?.protected && !allowProtected) counts.protectedSkips += 1
    else counts.refreshes += 1
  }
  return counts
}
