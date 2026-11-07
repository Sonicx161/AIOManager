import { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } from 'react'
import { Film, Tv } from 'lucide-react'
import { cn, sanitizePosterUrl } from '@/lib/utils'
import { isProxyableUrl, getCinemetaPosterUrl } from '@/lib/cinemeta-utils'
import { fetchKitsuMeta, parseKitsuId } from '@/lib/kitsu-meta'
import { imdbIdFromPosterUrl, pickUniqueTmdbTitleMatch, type TmdbTitleCandidate, type TmdbTitleMatch } from '@/lib/activity-artwork'
import { clampProxyWidth, posterImageCandidates, proxyImageUrl, retargetImageUrl, sizeTmdbUrl } from '@/lib/image-proxy'
import { artIdentity, artSnapshot, clearArtFailures, markArtFailed, markArtLoaded, orderArtCandidates, publishedArt, subscribeArt, type ArtCandidate } from '@/lib/poster-art'

interface PosterProps extends React.ImgHTMLAttributes<HTMLImageElement> {
    itemId?: string
    itemType?: string
    fallback?: boolean
    displayWidth?: number
    /** Row TMDB id: last-resort poster through the keyed /api/metadata/tmdb proxy. */
    tmdbId?: number
    /** Row title and year for the strict last-resort TMDB title search. */
    name?: string
    year?: number
}

function proxyUrl(url: string | undefined, width?: number): string | undefined {
    if (!url) return undefined
    if (isProxyableUrl(url) && !url.startsWith('/api/proxy-image')) {
        return proxyImageUrl(url, width)
    }
    // Stored poster URLs can already be proxied pass-throughs; re-point them at the
    // displayed width the same way (never signed avatar URLs, whose w is part of the signature).
    if (width && url.startsWith('/api/proxy-image') && !url.includes('kind=avatar')) {
        return retargetImageUrl(url, width) ?? url
    }
    return width ? sizeTmdbUrl(url, width) : url
}

function getCinemetaItemId(itemId: string | undefined): string | undefined {
    return itemId?.match(/tt\d+/i)?.[0]
}

const TMDB_TV_TYPES = new Set(['series', 'anime', 'episode', 'tv'])
const tmdbPosterCache = new Map<string, Promise<string | undefined>>()

/** Poster path by TMDB id through the keyed TMDB proxy; undefined when no key or no art exists. */
function fetchTmdbPosterUrl(tmdbId: number, itemType?: string): Promise<string | undefined> {
    const mediaType = TMDB_TV_TYPES.has(itemType || '') ? 'tv' : 'movie'
    const key = `${mediaType}:${tmdbId}`
    let request = tmdbPosterCache.get(key)
    if (!request) {
        request = (async () => {
            const { proxyFetch, TMDB_IMAGE_BASE } = await import('@/api/metadata/adapters/tmdb')
            const data = await proxyFetch<{ posters?: Array<{ file_path?: string }> }>(
                `${mediaType}/${tmdbId}/images?include_image_language=en,null`,
                AbortSignal.timeout(8_000),
            )
            const path = data?.posters?.find(poster => typeof poster.file_path === 'string' && poster.file_path)?.file_path
            return path ? `${TMDB_IMAGE_BASE}/w500${path}` : undefined
        })()
        tmdbPosterCache.set(key, request)
        request.catch(() => tmdbPosterCache.delete(key))
    }
    return request
}

const tmdbTitleCache = new Map<string, Promise<TmdbTitleMatch | undefined>>()

/**
 * Strict last-resort artwork by exact title search through the keyed TMDB proxy.
 * Only a unique exact-title hit (and year, when known) resolves; a null payload
 * (no key configured, transport failure) resolves undefined.
 */
export function fetchTmdbArtworkByTitle(
    name: string,
    year: number | undefined,
    itemType?: string,
): Promise<TmdbTitleMatch | undefined> {
    const mediaType = TMDB_TV_TYPES.has(itemType || '') ? 'tv' : 'movie'
    const title = name.trim()
    const knownYear = typeof year === 'number' && year > 0 ? year : undefined
    const key = `${mediaType}:${title.toLowerCase()}:${knownYear ?? ''}`
    let request = tmdbTitleCache.get(key)
    if (!request) {
        request = (async () => {
            const { proxyFetch } = await import('@/api/metadata/adapters/tmdb')
            const params = new URLSearchParams({ query: title })
            if (knownYear) params.set('year', String(knownYear))
            const data = await proxyFetch<{ results?: TmdbTitleCandidate[] }>(
                `search/${mediaType}?${params.toString()}`,
                AbortSignal.timeout(8_000),
            )
            return pickUniqueTmdbTitleMatch(title, knownYear, data?.results)
        })()
        tmdbTitleCache.set(key, request)
        request.catch(() => tmdbTitleCache.delete(key))
    }
    return request
}

if (typeof window !== 'undefined') window.addEventListener('online', clearArtFailures)

export function Poster({
    src,
    itemId,
    itemType,
    tmdbId,
    name,
    year,
    className,
    fallback = true,
    displayWidth,
    sizes,
    ...props
}: PosterProps) {
    const [recoveredPoster, setRecoveredPoster] = useState<string>()
    const kitsuRecoveryRef = useRef<string | null>(null)
    const tmdbRecoveryRef = useRef<number | null>(null)
    const titleRecoveryRef = useRef<string | null>(null)

    const width1x = displayWidth ? clampProxyWidth(displayWidth) : undefined

    const trimmedTitle = name?.trim()
    // Identity of the last-resort title search; null when the row has no usable name.
    const titleSearchKey = trimmedTitle ? `${itemType ?? ''}:${trimmedTitle.toLowerCase()}:${year ?? ''}` : null

    const { sources, identity } = useMemo(() => {
        const cleanSrc = sanitizePosterUrl(src)
        const effectiveSrc = typeof cleanSrc === 'string' && cleanSrc.trim() ? cleanSrc : undefined
        const cinemetaItemId = getCinemetaItemId(itemId) ?? imdbIdFromPosterUrl(effectiveSrc)
        const own: ArtCandidate[] = []
        const add = (base: string | undefined) => {
            const url = proxyUrl(base, width1x)
            if (base && url && !own.some(c => c.base === base)) own.push({ base, url })
        }
        let hasEmbeddedFallback = false
        if (typeof effectiveSrc === 'string') {
            try {
                const parsed = new URL(effectiveSrc)
                for (const key of ['fallback', 'url']) {
                    const val = parsed.searchParams.get(key)
                    if (val && val.startsWith('http')) {
                        hasEmbeddedFallback = true
                        add(val)
                    }
                }
            } catch {}
        }
        if (!hasEmbeddedFallback) add(effectiveSrc)
        if (fallback && cinemetaItemId) add(getCinemetaPosterUrl(cinemetaItemId))
        const kitsuId = parseKitsuId(itemId)
        return {
            sources: own,
            identity: artIdentity({ imdbId: cinemetaItemId, tmdbId, itemType, kitsuId: kitsuId ? String(kitsuId) : undefined }),
        }
    }, [src, itemId, fallback, width1x, tmdbId, itemType])

    useEffect(() => {
        setRecoveredPoster(undefined)
        kitsuRecoveryRef.current = null
        tmdbRecoveryRef.current = null
        titleRecoveryRef.current = null
    }, [sources, itemId, tmdbId, titleSearchKey])

    const own = useMemo(() => {
        const recovered = recoveredPoster ? proxyUrl(recoveredPoster, width1x) : undefined
        return recoveredPoster && recovered ? [{ base: recoveredPoster, url: recovered }, ...sources] : sources
    }, [recoveredPoster, sources, width1x])

    // Re-render only when this title's published art or one of this poster's sources changes.
    const artKeys = useMemo(() => {
        const pub = publishedArt(identity)
        return [...(identity ? [identity] : []), ...own.map(c => c.base), ...(pub ? [pub] : [])]
    }, [identity, own])
    const artKeysId = artKeys.join('|')
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const subscribe = useCallback((listener: () => void) => subscribeArt(artKeys, listener), [artKeysId])
    const artVersion = useSyncExternalStore(subscribe, () => artSnapshot(artKeys))

    const candidates = useMemo(
        () => orderArtCandidates(own, identity, base => proxyUrl(base, width1x) ?? base),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [own, identity, width1x, artVersion],
    )
    const current = candidates[0]
    const currentSrc = current?.url
    const srcSet = useMemo(() => {
        if (!currentSrc || !displayWidth) return undefined
        const hi = retargetImageUrl(currentSrc, displayWidth * 2)
        return hi && hi !== currentSrc ? `${currentSrc} 1x, ${hi} 2x` : undefined
    }, [currentSrc, displayWidth])
    // Width-descriptor ladder for `sizes` consumers: every candidate is a true
    // served pixel width, so the browser (which knows the DPR) always picks a file
    // at or above rendered px x DPR. Null for sources without sized variants ;
    // those keep the original source.
    const widthLadder = useMemo(() => {
        if (!sizes || !currentSrc) return null
        return posterImageCandidates(currentSrc)
    }, [currentSrc, sizes])
    const widthSrcSet = useMemo(
        () => widthLadder?.map(candidate => `${candidate.url} ${candidate.width}w`).join(', ') ?? undefined,
        [widthLadder],
    )

    useEffect(() => {
        const kitsuId = parseKitsuId(itemId)
        if (!kitsuId || sources.length > 0 || kitsuRecoveryRef.current) return
        kitsuRecoveryRef.current = kitsuId
        let active = true
        void fetchKitsuMeta(kitsuId).then(meta => {
            if (active && meta?.poster) setRecoveredPoster(meta.poster)
        })
        return () => { active = false }
    }, [itemId, sources])

    // Rows that carry only a TMDB id (no poster, no IMDb identity) recover through the keyed proxy.
    useEffect(() => {
        if (typeof tmdbId !== 'number' || sources.length > 0 || tmdbRecoveryRef.current === tmdbId) return
        tmdbRecoveryRef.current = tmdbId
        let active = true
        void fetchTmdbPosterUrl(tmdbId, itemType).then(url => {
            if (!active) return
            if (url) {
                setRecoveredPoster(url)
                return
            }
            // The id path failed: the exact-title search is the next and last resort.
            if (titleSearchKey && titleRecoveryRef.current !== titleSearchKey) {
                titleRecoveryRef.current = titleSearchKey
                void fetchTmdbArtworkByTitle(trimmedTitle!, year, itemType).then(match => {
                    if (active && match?.posterUrl) setRecoveredPoster(match.posterUrl)
                })
            }
        })
        return () => { active = false }
    }, [tmdbId, sources, itemType, titleSearchKey, trimmedTitle, year])

    // Last resort with no keyed id at all: no poster, no IMDb identity, only the exact title.
    useEffect(() => {
        if (!titleSearchKey || typeof tmdbId === 'number' || sources.length > 0 || titleRecoveryRef.current === titleSearchKey) return
        titleRecoveryRef.current = titleSearchKey
        let active = true
        void fetchTmdbArtworkByTitle(trimmedTitle!, year, itemType).then(match => {
            if (active && match?.posterUrl) setRecoveredPoster(match.posterUrl)
        })
        return () => { active = false }
    }, [titleSearchKey, tmdbId, sources, trimmedTitle, year, itemType])

    const attemptTitleRecovery = (): boolean => {
        if (!titleSearchKey || titleRecoveryRef.current === titleSearchKey) return false
        titleRecoveryRef.current = titleSearchKey
        void fetchTmdbArtworkByTitle(trimmedTitle!, year, itemType).then(match => {
            if (match?.posterUrl) setRecoveredPoster(match.posterUrl)
        })
        return true
    }

    // A failed image is skipped by every poster of this title, so the next candidate is the
    // same everywhere; recoveries run alongside and take over when they resolve.
    const handleError = () => {
        if (current) markArtFailed(identity, current.base)
        const kitsuId = parseKitsuId(itemId)
        if (kitsuId && !kitsuRecoveryRef.current) {
            kitsuRecoveryRef.current = kitsuId
            void fetchKitsuMeta(kitsuId).then(meta => {
                if (meta?.poster) setRecoveredPoster(meta.poster)
            })
            return
        }
        if (typeof tmdbId === 'number' && tmdbRecoveryRef.current !== tmdbId) {
            tmdbRecoveryRef.current = tmdbId
            void fetchTmdbPosterUrl(tmdbId, itemType).then(url => {
                if (url) setRecoveredPoster(url)
                else attemptTitleRecovery()
            })
            return
        }
        attemptTitleRecovery()
    }

    if (!currentSrc) {
        return (
            <div className={cn(
                "w-full h-full flex items-center justify-center bg-muted/40 transition-[transform,opacity,box-shadow]",
                className
            )}>
                <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 p-2">
                    {itemType === 'series' ? (
                        <Tv className="h-6 w-6 text-muted-foreground/30" />
                    ) : (
                        <Film className="h-6 w-6 text-muted-foreground/30" />
                    )}
                    {props.alt && (
                        <span className="line-clamp-2 text-center text-[10px] font-medium text-muted-foreground/50">{props.alt}</span>
                    )}
                </div>
            </div>
        )
    }

    return (
        <img
            loading="lazy"
            decoding="async"
            src={currentSrc}
            srcSet={widthSrcSet ?? srcSet}
            sizes={widthSrcSet ? sizes : undefined}
            className={cn("w-full h-full object-cover", className)}
            onError={handleError}
            {...props}
            onLoad={(event) => { if (current) markArtLoaded(identity, current.base); props.onLoad?.(event) }}
        />
    )
}
