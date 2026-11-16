import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { motion } from 'framer-motion'
import { Search, X, Film, Tv, Star, User, ArrowLeft, ChevronRight } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Poster } from '@/components/common/Poster'
import { searchCinemeta, proxyFetch, TMDB_IMAGE_BASE, type SearchResult } from '@/api/metadata/adapters/tmdb'
import { traceAsync } from '@/api/metadata/adapters/shared-fetch'
import { cn } from '@/lib/utils'

interface SearchDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onResultClick: (result: SearchResult) => void
}

interface PersonMatch {
    id: number
    name: string
    profile: string | null
    knownFor: string
}

const DEBOUNCE_MS = 300

function mapTmdbResults(raw: Array<Record<string, unknown>>): SearchResult[] {
    return raw
        .filter(r => !!r && (r.media_type === 'movie' || r.media_type === 'tv') && typeof r.id === 'number')
        .map(r => {
            const relDate = (r.release_date as string) || (r.first_air_date as string)
            const posterPath = r.poster_path as string | null | undefined
            const backdropPath = r.backdrop_path as string | null | undefined
            return {
                id: `tmdb:${r.id}`,
                tmdbId: r.id as number,
                type: r.media_type === 'tv' ? 'series' as const : 'movie' as const,
                name: (r.title as string) || (r.name as string) || 'Unknown',
                year: relDate ? relDate.slice(0, 4) : undefined,
                poster: posterPath ? `${TMDB_IMAGE_BASE}/w500${posterPath}` : undefined,
                backdrop: backdropPath ? `${TMDB_IMAGE_BASE}/original${backdropPath}` : undefined,
                overview: r.overview as string | undefined,
                voteAverage: typeof r.vote_average === 'number' ? r.vote_average : undefined,
            }
        })
}

export function SearchDialog({ open, onOpenChange, onResultClick }: SearchDialogProps) {
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<SearchResult[]>([])
    const [page, setPage] = useState(1)
    const [totalPages, setTotalPages] = useState(1)
    const [loading, setLoading] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [activeCategory, setActiveCategory] = useState<'all' | 'movie' | 'series'>('all')
    const [peopleResults, setPeopleResults] = useState<PersonMatch[]>([])
    const [selectedPerson, setSelectedPerson] = useState<PersonMatch | null>(null)
    const [personCredits, setPersonCredits] = useState<SearchResult[]>([])
    const [personLoading, setPersonLoading] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const abortRef = useRef<AbortController | null>(null)
    const sentinelRef = useRef<HTMLDivElement>(null)

    const categorized = useMemo(() => ({
        all: results,
        movie: results.filter(r => r.type === 'movie'),
        series: results.filter(r => r.type === 'series'),
    }), [results])

    const visibleResults = categorized[activeCategory]
    const hasMore = page < totalPages && !loading && !loadingMore

    useEffect(() => {
        if (open) {
            setQuery('')
            setResults([])
            setPage(1)
            setTotalPages(1)
            setError(null)
            setActiveCategory('all')
            setPeopleResults([])
            setSelectedPerson(null)
            setPersonCredits([])
            setLoading(false)
            setLoadingMore(false)
            setTimeout(() => inputRef.current?.focus(), 100)
        }
        return () => { abortRef.current?.abort() }
    }, [open])

    useEffect(() => {
        if (!query.trim()) {
            setResults([])
            setPeopleResults([])
            setPage(1)
            setTotalPages(1)
            setError(null)
            setLoading(false)
            return
        }
        const timer = setTimeout(async () => {
            abortRef.current?.abort()
            const ac = new AbortController()
            abortRef.current = ac
            setLoading(true)
            setError(null)
            setSelectedPerson(null)
            try {
                const [titleData, personData] = await Promise.all([
                    proxyFetch<{ results?: Array<Record<string, unknown>>; total_pages?: number }>(
                        `search/multi?query=${encodeURIComponent(query.trim())}&include_adult=false&page=1`,
                        ac.signal
                    ),
                    proxyFetch<{ results?: Array<{ id: number; name?: string; profile_path?: string | null; known_for_department?: string }> }>(
                        `search/person?query=${encodeURIComponent(query.trim())}&page=1`,
                        ac.signal
                    ).catch(() => null),
                ])
                if (ac.signal.aborted) return

                if (titleData?.results && titleData.results.length > 0) {
                    setResults(mapTmdbResults(titleData.results))
                    setTotalPages(titleData.total_pages ?? 1)
                } else {
                    const cinemetaData = await traceAsync('search-cinemeta', () => searchCinemeta(query, ac.signal))
                    if (!ac.signal.aborted) {
                        setResults(cinemetaData)
                        setTotalPages(1)
                        if (cinemetaData.length === 0 && !(personData?.results?.length)) {
                            setError('No results found. Try a different search.')
                        }
                    }
                }

                if (personData?.results) {
                    setPeopleResults(personData.results
                        .filter(r => r.id && r.name)
                        .slice(0, 8)
                        .map(r => ({
                            id: r.id,
                            name: r.name!,
                            profile: r.profile_path ? `${TMDB_IMAGE_BASE}/w185${r.profile_path}` : null,
                            knownFor: r.known_for_department || 'Acting',
                        })))
                }
            } catch {
                if (!ac.signal.aborted) {
                    const cinemetaData = await traceAsync('search-cinemeta', () => searchCinemeta(query, ac.signal))
                    if (!ac.signal.aborted) {
                        setResults(cinemetaData)
                        setTotalPages(1)
                        if (cinemetaData.length === 0) setError('Search failed. TMDB key may not be configured.')
                    }
                }
            } finally {
                if (!ac.signal.aborted) setLoading(false)
            }
        }, DEBOUNCE_MS)
        return () => clearTimeout(timer)
    }, [query])

    const loadMore = useCallback(async () => {
        if (loading || loadingMore || page >= totalPages) return
        const nextPage = page + 1
        setLoadingMore(true)
        const ac = new AbortController()
        abortRef.current = ac
        try {
            const data = await proxyFetch<{ results?: Array<Record<string, unknown>> }>(
                `search/multi?query=${encodeURIComponent(query.trim())}&include_adult=false&page=${nextPage}`,
                ac.signal
            )
            if (ac.signal.aborted) return
            if (data?.results) {
                setResults(prev => [...prev, ...mapTmdbResults(data.results!)])
                setPage(nextPage)
            }
        } catch {} finally {
            setLoadingMore(false)
        }
    }, [query, page, totalPages, loading, loadingMore])

    useEffect(() => {
        if (selectedPerson) return
        const sentinel = sentinelRef.current
        if (!sentinel) return
        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) loadMore()
        }, { rootMargin: '200px' })
        observer.observe(sentinel)
        return () => observer.disconnect()
    }, [loadMore, selectedPerson])

    useEffect(() => {
        if (!selectedPerson) {
            setPersonCredits([])
            return
        }
        const ac = new AbortController()
        abortRef.current = ac
        setPersonLoading(true)
        void (async () => {
            try {
                const data = await proxyFetch<{
                    cast?: Array<{ id: number; title?: string; name?: string; poster_path?: string | null; backdrop_path?: string | null; release_date?: string; first_air_date?: string; vote_average?: number; vote_count?: number; media_type?: string }>
                }>(`person/${selectedPerson.id}/combined_credits`, ac.signal)
                if (!ac.signal.aborted && data?.cast) {
                    setPersonCredits(data.cast
                        .filter(c => c.poster_path && (c.vote_count ?? 0) >= 5)
                        .sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))
                        .map(c => ({
                            id: `tmdb:${c.id}`,
                            tmdbId: c.id,
                            type: (c.media_type === 'tv' ? 'series' : 'movie') as 'movie' | 'series',
                            name: c.title || c.name || 'Unknown',
                            year: (c.release_date || c.first_air_date || '').slice(0, 4) || undefined,
                            poster: c.poster_path ? `${TMDB_IMAGE_BASE}/w500${c.poster_path}` : undefined,
                            backdrop: c.backdrop_path ? `${TMDB_IMAGE_BASE}/original${c.backdrop_path}` : undefined,
                            voteAverage: typeof c.vote_average === 'number' ? c.vote_average : undefined,
                        })))
                }
            } catch {} finally {
                if (!ac.signal.aborted) setPersonLoading(false)
            }
        })()
        return () => ac.abort()
    }, [selectedPerson])

    const handleResultClick = useCallback((result: SearchResult) => {
        onResultClick(result)
        onOpenChange(false)
    }, [onResultClick, onOpenChange])

    const showInitial = !loading && !error && results.length === 0 && !query.trim() && !selectedPerson
    const showPersonView = !!selectedPerson
    const showTitleGrid = !showPersonView && !loading && !error && results.length > 0

    const renderResultCard = (result: SearchResult, i: number) => (
        <motion.button
            key={`${result.id}-${i}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.02, 0.2), duration: 0.15 }}
            onClick={() => handleResultClick(result)}
            className="group flex flex-col gap-1.5 text-left"
        >
            <div data-theme-part="card" className="relative aspect-[2/3] overflow-hidden rounded-xl border border-border/40 bg-muted shadow-sm transition-[transform,opacity,box-shadow] duration-200 group-hover:border-primary/50 group-hover:shadow-lg">
                <Poster
                    src={result.poster}
                    itemId={result.id}
                    itemType={result.type}
                    alt={result.name}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    loading="lazy"
                />
                <div className="absolute right-1.5 top-1.5">
                    {result.type === 'series' ? (
                        <Tv className="h-3.5 w-3.5 text-white/80 drop-shadow-lg" />
                    ) : (
                        <Film className="h-3.5 w-3.5 text-white/80 drop-shadow-lg" />
                    )}
                </div>
                {typeof result.voteAverage === 'number' && result.voteAverage > 0 && (
                    <div className="absolute bottom-1.5 right-1.5">
                        <span data-theme-part="badge" className="flex items-center gap-0.5 rounded-full bg-black/75 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-white/90 backdrop-blur-sm">
                            <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />
                            {result.voteAverage.toFixed(1)}
                        </span>
                    </div>
                )}
            </div>
            <p className="line-clamp-1 text-xs font-semibold leading-tight">{result.name}</p>
            {result.year && (
                <p className="text-[10px] text-muted-foreground">{result.year}</p>
            )}
        </motion.button>
    )

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-full sm:max-w-3xl max-h-[85vh] flex flex-col overflow-hidden p-0 gap-0">
                <div className="relative flex items-center gap-3 border-b border-border/40 px-3 py-2 sm:px-4 sm:py-3">
                    <Search className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <input
                        data-theme-part="input"
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); setActiveCategory('all') }}
                        placeholder="Search movies, series, anime, people…"
                        className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                    />
                    {query && (
                        <button data-theme-part="button"
                            type="button"
                            onClick={() => { setQuery(''); setActiveCategory('all') }}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    )}
                </div>

                <div className="flex-1 overflow-y-auto p-3 sm:p-4">
                    {showPersonView && (
                        <>
                            <div className="mb-3 flex items-center gap-3">
                                <button data-theme-part="button"
                                    type="button"
                                    onClick={() => setSelectedPerson(null)}
                                    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                                >
                                    <ArrowLeft className="h-3.5 w-3.5" />
                                    Back
                                </button>
                                <div className="flex items-center gap-2.5">
                                    {selectedPerson.profile ? (
                                        <img
                                            src={selectedPerson.profile}
                                            alt={selectedPerson.name}
                                            className="h-8 w-8 rounded-full object-cover border border-border/40"
                                        />
                                    ) : (
                                        <div data-theme-part="avatar" className="flex h-8 w-8 items-center justify-center rounded-full bg-muted border border-border/40">
                                            <User className="h-4 w-4 text-muted-foreground/50" />
                                        </div>
                                    )}
                                    <div>
                                        <p className="text-sm font-bold leading-tight">{selectedPerson.name}</p>
                                        <p className="text-[10px] text-muted-foreground">{selectedPerson.knownFor}</p>
                                    </div>
                                </div>
                            </div>

                            {personLoading ? (
                                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 sm:gap-3">
                                    {Array.from({ length: 10 }).map((_, i) => (
                                        <div key={i} className="space-y-1.5">
                                            <Skeleton className="aspect-[2/3] w-full rounded-xl" />
                                            <Skeleton className="h-3 w-full" />
                                        </div>
                                    ))}
                                </div>
                            ) : personCredits.length > 0 ? (
                                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 sm:gap-3">
                                    {personCredits.map((result, i) => renderResultCard(result, i))}
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center py-12 text-center">
                                    <p className="text-sm font-medium text-muted-foreground">No credits found for this person.</p>
                                </div>
                            )}
                        </>
                    )}

                    {!showPersonView && loading && (
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 sm:gap-3">
                            {Array.from({ length: 10 }).map((_, i) => (
                                <div key={i} className="space-y-1.5">
                                    <Skeleton className="aspect-[2/3] w-full rounded-xl" />
                                    <Skeleton className="h-3 w-full" />
                                </div>
                            ))}
                        </div>
                    )}

                    {!showPersonView && error && !loading && (
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                            <p className="text-sm font-medium text-muted-foreground">{error}</p>
                        </div>
                    )}

                    {!showPersonView && !loading && peopleResults.length > 0 && (
                        <div className="mb-4">
                            <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
                                <User className="h-3 w-3" />
                                People
                            </p>
                            <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-thin">
                                {peopleResults.map((person, i) => (
                                    <motion.button
                                        key={person.id}
                                        initial={{ opacity: 0, scale: 0.9 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.15 }}
                                        onClick={() => setSelectedPerson(person)}
                                        className="group flex w-16 shrink-0 flex-col items-center gap-1.5 text-center"
                                    >
                                        <div data-theme-part="avatar" className="relative h-16 w-16 overflow-hidden rounded-full border-2 border-border/40 bg-muted transition-all group-hover:border-primary/50 group-hover:scale-105">
                                            {person.profile ? (
                                                <img
                                                    src={person.profile}
                                                    alt={person.name}
                                                    className="h-full w-full object-cover"
                                                    loading="lazy"
                                                />
                                            ) : (
                                                <div className="flex h-full w-full items-center justify-center">
                                                    <User className="h-6 w-6 text-muted-foreground/40" />
                                                </div>
                                            )}
                                        </div>
                                        <p className="line-clamp-2 text-[10px] font-medium leading-tight">{person.name}</p>
                                    </motion.button>
                                ))}
                            </div>
                        </div>
                    )}

                    {showTitleGrid && (
                        <>
                            {results.length > 3 && (
                                <div className="mb-2 sm:mb-3 flex items-center gap-2">
                                    {([
                                        { id: 'all', label: 'All', count: categorized.all.length },
                                        { id: 'movie', label: 'Movies', count: categorized.movie.length },
                                        { id: 'series', label: 'TV Shows', count: categorized.series.length },
                                    ] as const).filter(cat => cat.count > 0).map(cat => (
                                        <button data-theme-part="nav-item" data-state={activeCategory === cat.id ? "active" : "inactive"} aria-pressed={activeCategory === cat.id}
                                            key={cat.id}
                                            type="button"
                                            onClick={() => setActiveCategory(cat.id)}
                                            className={cn(
                                                'flex items-center gap-1.5 rounded-full px-2 py-1 sm:px-3 sm:py-1.5 text-xs font-bold transition-all',
                                                activeCategory === cat.id
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'
                                            )}
                                        >
                                            {cat.label}
                                            <span data-theme-part="badge" className={cn(
                                                'rounded-full px-1.5 text-[10px]',
                                                activeCategory === cat.id ? 'bg-black/20' : 'bg-muted/60'
                                            )}>
                                                {cat.count}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            )}

                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 sm:gap-3">
                                {visibleResults.map((result, i) => renderResultCard(result, i))}
                            </div>

                            {hasMore && activeCategory === 'all' && (
                                <div ref={sentinelRef} className="flex items-center justify-center py-6">
                                    {loadingMore ? (
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                            Loading more...
                                        </div>
                                    ) : (
                                        <button data-theme-part="button"
                                            type="button"
                                            onClick={loadMore}
                                            className="flex items-center gap-1.5 rounded-full bg-muted/40 px-4 py-2 text-xs font-bold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                                        >
                                            Load more
                                            <ChevronRight className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                            )}

                            {loadingMore && activeCategory === 'all' && (
                                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 sm:gap-3 mt-2">
                                    {Array.from({ length: 5 }).map((_, i) => (
                                        <div key={i} className="space-y-1.5">
                                            <Skeleton className="aspect-[2/3] w-full rounded-xl" />
                                            <Skeleton className="h-3 w-full" />
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}

                    {showInitial && (
                        <div className="flex flex-col items-center justify-center py-12 sm:py-16 text-center">
                            <div data-theme-part="badge" className="mb-3 sm:mb-4 flex h-12 w-12 sm:h-14 sm:w-14 items-center justify-center rounded-full bg-muted/40">
                                <Search className="h-6 w-6 text-muted-foreground/40" />
                            </div>
                            <p className="text-sm font-semibold text-muted-foreground">Start typing to search</p>
                            <p className="mt-1 text-xs text-muted-foreground/60">Find movies, shows, or people</p>
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}
