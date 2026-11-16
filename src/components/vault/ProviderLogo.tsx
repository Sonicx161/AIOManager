import { useState } from 'react'
import type { ReactNode } from 'react'
import { providerLogoPath } from '@/lib/provider-logo'

interface ProviderLogoProps {
    catalogId?: string
    provider?: string
    fallback: ReactNode
    className?: string
    imgClassName?: string
    alt?: string
}

export function ProviderLogo({ catalogId, provider, fallback, className, imgClassName, alt = '' }: ProviderLogoProps) {
    const src = providerLogoPath({ catalogId, provider })
    const [failedSrc, setFailedSrc] = useState<string>()
    if (!src || failedSrc === src) return <>{fallback}</>
    return (
        <span className={className} aria-hidden={alt ? undefined : true}>
            <img
                src={src}
                alt={alt}
                loading="lazy"
                decoding="async"
                onError={() => setFailedSrc(src)}
                className={imgClassName}
            />
        </span>
    )
}
