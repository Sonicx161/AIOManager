import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { tileLetter } from './account-stat-chips'

/** Addon logo tile with a letter fallback while loading or when the logo fails. */
export function AddonPreviewTile({ src, name }: { src?: string; name?: string }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setLoaded(false); setFailed(false) }, [src])
  return (
    <div data-theme-part="image-tile" className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/30 ring-1 ring-border/20 md:h-6 md:w-6">
      <span aria-hidden="true" className={cn('text-[10px] font-semibold leading-none text-muted-foreground transition-opacity duration-200', loaded && 'opacity-0')}>{tileLetter(name)}</span>
      {src && !failed && (
        <img
          ref={(el) => { if (el && !loaded && el.complete && el.naturalWidth > 0) setLoaded(true) }}
          src={src}
          alt={name}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn('absolute inset-0 h-full w-full object-contain p-0.5 transition-opacity duration-200', loaded ? 'opacity-100' : 'opacity-0')}
        />
      )}
    </div>
  )
}
