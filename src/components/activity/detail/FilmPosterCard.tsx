import { memo } from 'react'
import { WatcherBadges } from '@/components/activity/detail/WatcherBadges'
import type { FilmographyItem } from '@/components/activity/detail/types'
import type { RailWatcher } from '@/components/ui/content-rail'

interface FilmPosterCardProps {
    film: FilmographyItem
    watchers?: RailWatcher[]
    onClick: () => void
    showSubtitle?: boolean
    className?: string
}

export const FilmPosterCard = memo(function FilmPosterCard({
    film,
    watchers,
    onClick,
    showSubtitle = true,
    className,
}: FilmPosterCardProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={className ?? 'group flex flex-col items-center text-center focus:outline-none'}
        >
            <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-muted border border-[color:var(--chrome-line)] shadow-sm transition-[transform,opacity,box-shadow] duration-200 group-hover:border-primary/50 group-hover:shadow-lg">
                {film.poster ? (
                    <img
                        src={film.poster}
                        alt={film.title}
                        className="media-ring h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                        loading="lazy"
                        onError={(e) => { e.currentTarget.style.visibility = 'hidden' }}
                    />
                ) : (
                    <div className="flex h-full w-full items-center justify-center p-3 text-center text-xs font-bold text-muted-foreground">
                        {film.title}
                    </div>
                )}

                {film.year && (
                    <span className="absolute right-2 top-2 rounded-md bg-black/80 px-1.5 py-0.5 text-[10px] font-bold text-white shadow backdrop-blur-sm">
                        {film.year}
                    </span>
                )}

                <WatcherBadges watchers={watchers ?? []} />
            </div>

            <div className="mt-2 flex w-full flex-col items-center px-1 text-center">
                <p className="line-clamp-2 min-h-[2.25rem] flex items-center justify-center text-xs font-bold leading-tight text-foreground group-hover:text-primary">
                    {film.title}
                </p>
                {showSubtitle && (film.character || film.job) && (
                    <p className="mt-0.5 line-clamp-1 text-[11px] leading-tight text-muted-foreground/70">
                        {film.character ? `as ${film.character}` : film.job}
                    </p>
                )}
            </div>
        </button>
    )
})
