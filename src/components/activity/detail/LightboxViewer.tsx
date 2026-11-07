import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, ZoomIn, X, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface LightboxViewerProps {
    images: string[]
    index: number | null
    zoom: boolean
    onClose: () => void
    onNavigate: (index: number) => void
    onToggleZoom: () => void
}

export function LightboxViewer({ images, index, zoom, onClose, onNavigate, onToggleZoom }: LightboxViewerProps) {
    if (index === null) return null
    return (
        <LightboxOpen
            images={images}
            index={index}
            zoom={zoom}
            onClose={onClose}
            onNavigate={onNavigate}
            onToggleZoom={onToggleZoom}
        />
    )
}

interface LightboxOpenProps {
    images: string[]
    index: number
    zoom: boolean
    onClose: () => void
    onNavigate: (index: number) => void
    onToggleZoom: () => void
}

function LightboxOpen({ images, index, zoom, onClose, onNavigate, onToggleZoom }: LightboxOpenProps) {
    const closeRef = useRef<HTMLButtonElement>(null)
    const returnFocusRef = useRef<HTMLElement | null>(null)

    useEffect(() => {
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        closeRef.current?.focus({ preventScroll: true })
        return () => {
            if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus({ preventScroll: true })
        }
    }, [])

    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        // Portal events still bubble through the React tree to the Dialog root, so swallow every key here.
        e.stopPropagation()
        if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
        } else if (e.key === 'ArrowLeft' && index > 0) {
            e.preventDefault()
            onNavigate(index - 1)
        } else if (e.key === 'ArrowRight' && index < images.length - 1) {
            e.preventDefault()
            onNavigate(index + 1)
        } else if (e.key === 'Tab') {
            const focusables = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]'))
            if (focusables.length === 0) return
            e.preventDefault()
            const current = focusables.indexOf(document.activeElement as HTMLElement)
            const dir = e.shiftKey ? -1 : 1
            focusables[(current + dir + focusables.length) % focusables.length].focus()
        }
    }

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label={`Image ${index + 1} of ${images.length}`}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm"
            onClick={onClose}
            onKeyDown={handleKeyDown}
        >
            <img
                src={images[index]}
                alt=""
                className={cn(
                    'rounded-lg object-contain shadow-2xl transition-transform duration-200 cursor-pointer',
                    zoom ? 'max-h-[100vh] max-w-[100vw] scale-150' : 'max-h-[90vh] max-w-[95vw]'
                )}
                onClick={(e) => { e.stopPropagation(); onToggleZoom() }}
                draggable={false}
            />
            {index > 0 && (
                <button
                    type="button"
                    data-theme-part="button"
                    onClick={(e) => { e.stopPropagation(); onNavigate(index - 1) }}
                    className="absolute left-4 top-1/2 -translate-y-1/2 flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white shadow-lg backdrop-blur-md transition-all hover:bg-black/80 hover:scale-110"
                    aria-label="Previous image"
                >
                    <ChevronLeft className="h-6 w-6" />
                </button>
            )}
            {index < images.length - 1 && (
                <button
                    type="button"
                    data-theme-part="button"
                    onClick={(e) => { e.stopPropagation(); onNavigate(index + 1) }}
                    className="absolute right-4 top-1/2 -translate-y-1/2 flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white shadow-lg backdrop-blur-md transition-all hover:bg-black/80 hover:scale-110"
                    aria-label="Next image"
                >
                    <ChevronRight className="h-6 w-6" />
                </button>
            )}
            <button
                type="button"
                data-theme-part="button"
                onClick={(e) => { e.stopPropagation(); onToggleZoom() }}
                className="absolute bottom-4 left-4 flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white shadow-lg backdrop-blur-md transition-all hover:bg-black/80 hover:scale-110"
                aria-label={zoom ? 'Zoom out' : 'Zoom in'}
            >
                <ZoomIn className="h-5 w-5" />
            </button>
            <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white backdrop-blur-md">
                {index + 1} / {images.length}
            </span>
            <button
                ref={closeRef}
                type="button"
                data-theme-part="button"
                onClick={onClose}
                className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white shadow-lg backdrop-blur-md transition-all hover:bg-black/80 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                aria-label="Close"
            >
                <X className="h-5 w-5" />
            </button>
            <a
                data-theme-part="button"
                href={images[index]}
                download
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="absolute bottom-4 right-4 flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white shadow-lg backdrop-blur-md transition-all hover:bg-black/80 hover:scale-110"
                aria-label="Open original"
            >
                <ExternalLink className="h-5 w-5" />
            </a>
        </div>,
        document.body,
    )
}
