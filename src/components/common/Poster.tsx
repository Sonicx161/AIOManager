import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { isProxyableUrl, getCinemetaPosterUrl } from '@/lib/cinemeta-utils'

interface PosterProps extends React.ImgHTMLAttributes<HTMLImageElement> {
    itemId?: string
    itemType?: string
    fallback?: boolean
}

export function Poster({
    src,
    itemId,
    itemType,
    className,
    fallback = true,
    ...props
}: PosterProps) {
    const [currentSrc, setCurrentSrc] = useState<string | undefined>(src)
    const [hasError, setHasError] = useState(false)
    const [triedFallback, setTriedFallback] = useState(false)

    useEffect(() => {
        // Apply proxy if needed
        if (src && isProxyableUrl(src) && !src.startsWith('/api/proxy-image')) {
            setCurrentSrc(`/api/proxy-image?url=${encodeURIComponent(src)}`)
        } else {
            setCurrentSrc(src)
        }
        setHasError(false)
        setTriedFallback(false)
    }, [src])

    const handleError = () => {
        if (!triedFallback && fallback && itemId && itemType) {
            setTriedFallback(true)
            const fallbackUrl = getCinemetaPosterUrl(itemId)
            setCurrentSrc(`/api/proxy-image?url=${encodeURIComponent(fallbackUrl)}`)
        } else {
            setHasError(true)
        }
    }

    if (hasError || !currentSrc) {
        return (
            <div className={cn(
                "w-full h-full bg-muted flex items-center justify-center text-muted-foreground transition-all",
                className
            )}>
                <div className="flex flex-col items-center gap-1 opacity-20">
                    <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <span className="text-[10px] font-black uppercase tracking-tight">No Image</span>
                </div>
            </div>
        )
    }

    return (
        <img
            src={currentSrc}
            className={cn("w-full h-full object-cover", className)}
            onError={handleError}
            {...props}
        />
    )
}
