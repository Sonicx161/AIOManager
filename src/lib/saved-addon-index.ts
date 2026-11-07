import type { AddonDescriptor } from '@/types/addon'
import { getAddonInstanceKey } from './addon-instance-identity.ts'

type SavedLike = { installUrl: string; manifest: AddonDescriptor['manifest'] }

const strip = (url: string) => url.split('?')[0].replace(/\/+$/, '')

// One pass over the library so per-card "is this addon saved" checks are O(1) set lookups.
export function buildSavedAddonIndex(library: Iterable<SavedLike>): (addon: Pick<AddonDescriptor, 'transportUrl' | 'manifest'>) => boolean {
  const urlKeys = new Set<string>()
  const instanceKeys = new Set<string>()
  for (const saved of library) {
    const id = saved.manifest.id
    urlKeys.add(`${id}\n${strip(saved.installUrl)}`)
    instanceKeys.add(`${id}\n${getAddonInstanceKey({ transportUrl: saved.installUrl, manifest: saved.manifest })}`)
  }
  return (addon) => {
    const id = addon.manifest.id
    return urlKeys.has(`${id}\n${strip(addon.transportUrl)}`) || instanceKeys.has(`${id}\n${getAddonInstanceKey(addon)}`)
  }
}
