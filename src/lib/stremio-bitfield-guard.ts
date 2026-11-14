import type { AddonDescriptor } from '../types/addon.ts'
import { sortMetaVideos, type MetaVideo } from './watched-episodes.ts'

export const UNSAFE_EPISODE_LIST = "AIOManager can't safely change watched episodes for this show in Stremio yet, because this account may use a different episode list than Cinemeta. Nothing was changed."

export function allowsCinemetaBitfield(addons: AddonDescriptor[] | null, type: string, id: string): boolean {
    if (type !== 'series' || !/^tt\d+$/.test(id) || !addons?.length) return false
    let found = false
    for (const addon of addons) {
        const manifest = addon?.manifest
        if (!manifest || !Array.isArray(manifest.resources)) return false
        const resource = manifest.resources.find(entry => typeof entry === 'string' ? entry === 'meta' : entry?.name === 'meta')
        if (!resource) continue
        const short = typeof resource === 'string'
        const types = short ? manifest.types : resource.types
        const prefixes = short ? manifest.idPrefixes : resource.idPrefixes
        if (types !== undefined && (!Array.isArray(types) || types.some(value => typeof value !== 'string'))) return false
        if (!types?.includes(type)) continue
        if (prefixes !== undefined && (!Array.isArray(prefixes) || prefixes.some(prefix => typeof prefix !== 'string'))) return false
        if (prefixes?.length && !prefixes.some(prefix => id.startsWith(prefix))) continue
        try {
            const url = new URL(addon.transportUrl)
            if (found || url.protocol !== 'https:' || url.hostname !== 'v3-cinemeta.strem.io' || url.port || url.username || url.password || url.pathname !== '/manifest.json' || url.search || url.hash) return false
            found = true
        } catch { return false }
    }
    return found
}

export async function safeBitfieldVideos(
    readCollection: () => Promise<AddonDescriptor[] | null>, type: string, id: string,
): Promise<MetaVideo[] | null> {
    try {
        if (!allowsCinemetaBitfield(await readCollection(), type, id)) return null
        const response = await fetch(`https://v3-cinemeta.strem.io/meta/series/${id}.json`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
        if (!response.ok) return null
        const data = await response.json()
        const videos: unknown = data?.meta?.videos
        if (!Array.isArray(videos) || videos.length === 0) return null
        const ids = new Set<string>()
        const positions = new Set<string>()
        for (const video of videos) {
            if (!video || typeof video.id !== 'string' || !video.id || !Number.isSafeInteger(video.season) || video.season < 0 || !Number.isSafeInteger(video.episode) || video.episode < 0) return null
            const position = `${video.season}:${video.episode}`
            if (ids.has(video.id) || positions.has(position)) return null
            ids.add(video.id)
            positions.add(position)
        }
        return sortMetaVideos(videos as MetaVideo[])
    } catch { return null }
}
