// Maps a decoded WatchedBitField onto real episodes via the series' ordered Cinemeta video list,
// with a fail-closed anchor checksum so we never log an episode the user did not watch.
//
// stremio-core indexes the bitfield against the series' videos sorted by (season, episode,
// released) — Cinemeta returns them in arbitrary (and occasionally changing) order, so every
// list this module hands out is sorted ONCE at fetch (sortMetaVideos) and every consumer
// (anchor checks, index mapping, re-encode) sees the order stremio-core used.

import localforage from 'localforage'
import { deduped } from './request-dedupe.ts'

export interface MetaVideo {
    id: string
    season?: number | null
    episode?: number | null
    released?: string | null
}

export interface WatchedEpisode {
    index: number
    videoId: string
    season: number | null
    episode: number | null
}

export interface DecodedLike {
    videoId: string
    length: number
    watchedIndices: number[]
}

export function resolveWatchedEpisodes(decoded: DecodedLike | null, videos: MetaVideo[] | null): WatchedEpisode[] | null {
    if (!decoded || !Array.isArray(videos) || videos.length === 0) return null
    const bits = decoded.watchedIndices
    if (!bits || bits.length === 0) return null

    const maxBit = bits[bits.length - 1]
    const anchor = videos[maxBit]
    if (!anchor || anchor.id !== decoded.videoId) return null // checksum: fail closed

    const episodes: WatchedEpisode[] = []
    for (const idx of bits) {
        const v = videos[idx]
        if (!v || !v.id) return null // span exceeds the meta list -> not aligned, fail closed
        episodes.push({ index: idx, videoId: v.id, season: v.season ?? null, episode: v.episode ?? null })
    }
    return episodes
}

const META_TTL_MS = 6 * 60 * 60 * 1000
const META_CACHE_MAX = 1000
const metaCache = new Map<string, { videos: MetaVideo[]; ts: number }>()

// Mirrors stremio-core's LibraryItemState::watched_bitfield() ordering: (season, episode,
// released). Sorting at the fetch boundary means cache, IndexedDB persistence and every
// consumer agree on one index space — a raw-order list would mis-map every bit after the
// first out-of-order video.
export function sortMetaVideos(videos: MetaVideo[]): MetaVideo[] {
    return [...videos].sort((a, b) => {
        const seasonDelta = (a.season ?? 0) - (b.season ?? 0)
        if (seasonDelta !== 0) return seasonDelta
        const episodeDelta = (a.episode ?? 0) - (b.episode ?? 0)
        if (episodeDelta !== 0) return episodeDelta
        return (a.released ?? '').localeCompare(b.released ?? '')
    })
}

const PERSIST_TTL_MS = 24 * 60 * 60 * 1000
const PERSIST_PREFIX = 'cinemeta:'

function persistAvailable(): boolean {
    return typeof indexedDB !== 'undefined'
}

async function readPersistedVideos(base: string): Promise<MetaVideo[] | null> {
    if (!persistAvailable()) return null
    try {
        const entry = await localforage.getItem<{ data: MetaVideo[]; ts: number }>(PERSIST_PREFIX + base)
        if (!entry || typeof entry.ts !== 'number') return null
        if (Date.now() - entry.ts >= PERSIST_TTL_MS) return null
        if (!Array.isArray(entry.data)) return null
        return entry.data
    } catch {
        return null
    }
}

function writePersistedVideos(base: string, data: MetaVideo[]): void {
    if (!persistAvailable()) return
    localforage.setItem(PERSIST_PREFIX + base, { data, ts: Date.now() }).catch(() => { })
}

/** Episode list from memory or the persisted cache only; never fetches. */
export async function getCachedSeriesVideos(seriesId: string): Promise<MetaVideo[] | null> {
    const base = String(seriesId || '').split(':')[0]
    if (!base.startsWith('tt')) return null
    const cached = metaCache.get(base)
    if (cached && Date.now() - cached.ts < META_TTL_MS) return cached.videos
    const persisted = await readPersistedVideos(base)
    if (!persisted) return null
    const videos = sortMetaVideos(persisted)
    metaCache.set(base, { videos, ts: Date.now() })
    return videos
}

// Cinemeta is CORS-open, so fetch directly. tt... only (kitsu/other namespaces are indexed against a
// different meta ordering and would mis-map; they fail closed). One retry after a short backoff so a
// transient Cinemeta blip does not brick a per-episode delete.
export async function fetchSeriesVideos(seriesId: string): Promise<MetaVideo[] | null> {
    const base = String(seriesId || '').split(':')[0]
    if (!base.startsWith('tt')) return null

    const cached = metaCache.get(base)
    if (cached && Date.now() - cached.ts < META_TTL_MS) return cached.videos

    const first = await deduped(`cinemeta:${base}`, () => fetchVideosOnce(base))
    if (first) return first

    await new Promise(resolve => setTimeout(resolve, 1500))
    return deduped(`cinemeta-retry:${base}`, () => fetchVideosOnce(base))
}

async function fetchVideosOnce(base: string): Promise<MetaVideo[] | null> {
    const persisted = await readPersistedVideos(base)
    if (persisted) {
        // Re-sort persisted lists too: entries written before the sort landed are in raw order.
        const videos = sortMetaVideos(persisted)
        metaCache.set(base, { videos, ts: Date.now() })
        return videos
    }

    try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 10000)
        const res = await fetch(`https://v3-cinemeta.strem.io/meta/series/${base}.json`, { signal: ctrl.signal }).finally(() => clearTimeout(t))
        if (!res.ok) return null
        const json = await res.json()
        const raw = json?.meta?.videos
        if (!Array.isArray(raw)) return null
        const videos = sortMetaVideos(raw)

        if (metaCache.size >= META_CACHE_MAX) {
            const oldest = [...metaCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, metaCache.size - META_CACHE_MAX + 1)
            for (const [k] of oldest) metaCache.delete(k)
        }
        metaCache.set(base, { videos, ts: Date.now() })
        writePersistedVideos(base, videos)
        return videos
    } catch {
        return null
    }
}
