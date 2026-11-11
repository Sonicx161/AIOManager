import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityItem } from '@/types/activity'
import { fetchCinemetaSlim } from '@/lib/cinemeta-cache'
import { fetchKitsuMeta } from '@/lib/kitsu-meta'
import { isImdbId, metahubPosterUrl } from '@/lib/activity-artwork'
import {
    applyResolvedMetadataOverlay,
    createTitleMetadataSearch,
    isUnresolvedActivityName,
    metadataTargetKey,
    selectMetadataBatch,
    type PendingMetadataTarget,
    type ResolvedMetadata,
} from '@/lib/activity-metadata-overlay'
import { watcherIdentityKeys } from '@/lib/watcher-identity'

const FAILED_LOOKUP_TTL_MS = 5 * 60 * 1000
const FIRST_PASS_SIZE = 20
const PASS_CHUNK_SIZE = 150
const LATER_PASS_SIZE = PASS_CHUNK_SIZE * 8
const PASS_COMMIT_BUDGET_MS = 1500
const TYPING_QUIET_MS = 600
const TYPING_DEFER_MAX_MS = 5000

let lastKeyAt = 0
let trackingKeys = false

function trackTyping() {
    if (trackingKeys || typeof window === 'undefined') return
    trackingKeys = true
    window.addEventListener('keydown', () => { lastKeyAt = Date.now() }, { capture: true, passive: true })
}

// A commit re-renders the whole feed, so it waits for a pause in typing.
async function waitForTypingPause(stillWanted: () => boolean): Promise<void> {
    const deadline = Date.now() + TYPING_DEFER_MAX_MS
    while (stillWanted() && Date.now() < deadline && Date.now() - lastKeyAt < TYPING_QUIET_MS) {
        await new Promise(resolve => setTimeout(resolve, 150))
    }
}

const searchTitleMetadata = createTitleMetadataSearch(async (name, mediaType) => {
    const { searchCinemeta } = await import('@/api/metadata/adapters/tmdb')
    return searchCinemeta(name, AbortSignal.timeout(8_000), mediaType)
}, { ttlMs: 5 * 60 * 1000, max: 500 })

/** TMDB id to IMDb id through the app's TMDB proxy, then public Cinemeta/metahub artwork. */
async function resolveTmdbTarget(target: Extract<PendingMetadataTarget, { kind: 'tmdb' }>): Promise<ResolvedMetadata | null> {
    const { proxyFetch } = await import('@/api/metadata/adapters/tmdb')
    const ids = await proxyFetch<{ imdb_id?: string | null }>(
        `${target.type === 'movie' ? 'movie' : 'tv'}/${target.tmdbId}/external_ids`,
        AbortSignal.timeout(8_000),
    )
    const imdbId = ids?.imdb_id
    if (isImdbId(imdbId)) {
        const meta = await fetchCinemetaSlim(imdbId, target.type)
        return { name: meta?.name ?? '', poster: metahubPosterUrl(imdbId), genres: meta?.genres }
    }
    return isUnresolvedActivityName(target.name) ? null : searchTitleMetadata(target.name, target.type)
}

/** Fill unresolved feed titles without letting failed lookups block later rows. */
export function useActivityMetadata(items: ActivityItem[]): ActivityItem[] {
    const [resolved, setResolved] = useState<Map<string, ResolvedMetadata>>(() => new Map())
    const failedAt = useRef(new Map<string, number>())
    const [completedPass, setCompletedPass] = useState(0)
    const reuseBySource = useRef(new WeakMap<ActivityItem, ActivityItem>())
    // Items identity marks the first (immediate) resolution pass for a feed; the
    // follow-up passes only fill rows below the fold and are deferred to idle.
    const firstPassForItems = useRef<unknown>(null)

    useEffect(() => {
        trackTyping()
        const firstPass = firstPassForItems.current !== items
        // Later passes resolve several chunks per commit; each commit re-derives the whole feed.
        const batch = selectMetadataBatch(items, resolved, failedAt.current, Date.now(), FAILED_LOOKUP_TTL_MS, firstPass ? FIRST_PASS_SIZE : LATER_PASS_SIZE)
        if (batch.length === 0) return
        let active = true
        // The first pass fills what is on screen right away; later passes only fill
        // rows below the fold, so they yield to interaction and run when idle.
        let cancelIdle = () => {}
        const lookup = async (target: PendingMetadataTarget): Promise<ResolvedMetadata | null> => {
            try {
                if (target.kind === 'imdb') {
                    const meta = await fetchCinemetaSlim(target.itemId, target.type)
                    return meta ? { name: meta.name, poster: meta.poster, genres: meta.genres } : null
                }
                if (target.kind === 'tmdb') return await resolveTmdbTarget(target)
                if (target.kind === 'kitsu') {
                    const meta = await fetchKitsuMeta(target.kitsuId)
                    return meta?.name ? { name: meta.name, poster: meta.poster, genres: meta.genres } : null
                }
                return await searchTitleMetadata(target.name, target.type)
            } catch {
                return null
            }
        }
        const run = async () => {
            const startedAt = Date.now()
            const attempted: PendingMetadataTarget[] = []
            const results: Array<ResolvedMetadata | null> = []
            for (let i = 0; i < batch.length; i += PASS_CHUNK_SIZE) {
                const chunk = batch.slice(i, i + PASS_CHUNK_SIZE)
                const settled = await Promise.all(chunk.map(lookup))
                if (!active) return
                attempted.push(...chunk)
                results.push(...settled)
                if (Date.now() - startedAt >= PASS_COMMIT_BUDGET_MS) break
            }
            if (!firstPass) await waitForTypingPause(() => active)
            if (!active) return
            const resolutions = new Map<string, ResolvedMetadata>()
            const now = Date.now()
            attempted.forEach((target, index) => {
                const key = metadataTargetKey(target)
                const value = results[index]
                if (value) {
                    resolutions.set(key, value)
                    failedAt.current.delete(key)
                } else {
                    failedAt.current.set(key, now)
                }
            })
            if (resolutions.size > 0) {
                setResolved(previous => new Map([...previous, ...resolutions]))
            } else {
                // An entirely failed batch still advances to the remaining titles.
                setCompletedPass(pass => pass + 1)
            }
        }
        if (firstPassForItems.current !== items) {
            firstPassForItems.current = items
            void run()
        } else if (typeof requestIdleCallback === 'function') {
            const id = requestIdleCallback(() => { if (active) void run() }, { timeout: 200 })
            cancelIdle = () => cancelIdleCallback(id)
        } else {
            const id = window.setTimeout(() => { if (active) void run() }, 200)
            cancelIdle = () => window.clearTimeout(id)
        }
        return () => { active = false; cancelIdle() }
    }, [items, resolved, completedPass])

    const sharedResolved = useMemo(() => {
        const next = new Map(resolved)
        for (const item of items) {
            const metadata = resolved.get(item.itemId)
            if (metadata) for (const key of watcherIdentityKeys(item)) next.set(key, metadata)
        }
        for (const item of items) {
            if (resolved.has(item.itemId)) continue
            const metadata = watcherIdentityKeys(item).map(key => next.get(key)).find(Boolean)
            if (metadata) next.set(item.itemId, metadata)
        }
        return next
    }, [items, resolved])

    return useMemo(() => applyResolvedMetadataOverlay(items, sharedResolved, reuseBySource.current), [items, sharedResolved])
}
