import { cn } from '@/lib/utils'
import { useState } from 'react'

interface AddonIconProps {
  name: string
  logo?: string
  alt?: string
  className?: string
  textClassName?: string
  imageClassName?: string
}

const MAX_ICON_ASPECT_RATIO = 2.35
const MIN_ICON_ASPECT_RATIO = 1 / MAX_ICON_ASPECT_RATIO
const SAMPLE_SIZE = 24
const MIN_SAMPLE_DISPLAY_SIZE = 20

// Emoji and other non-URL logo strings can only fail as <img src>; the letter renders at once.
export function isUsableLogoSrc(value: string): boolean {
  return /^(https?:|data:|blob:|\/)/i.test(value)
}

let sharedCanvas: HTMLCanvasElement | null = null
let sharedCanvasContext: CanvasRenderingContext2D | null = null

function hasBadIconShape(width: number, height: number) {
  if (!width || !height) return true
  const aspectRatio = width / height
  return aspectRatio > MAX_ICON_ASPECT_RATIO || aspectRatio < MIN_ICON_ASPECT_RATIO
}

function getSharedCanvasContext() {
  if (typeof document === 'undefined') return null

  if (!sharedCanvas) {
    sharedCanvas = document.createElement('canvas')
    sharedCanvas.width = SAMPLE_SIZE
    sharedCanvas.height = SAMPLE_SIZE
  }

  if (!sharedCanvasContext) {
    sharedCanvasContext = sharedCanvas.getContext('2d', { willReadFrequently: true })
  }

  return sharedCanvasContext
}

function resetSharedCanvas() {
  if (!sharedCanvas) return

  sharedCanvas.width = SAMPLE_SIZE
  sharedCanvas.height = SAMPLE_SIZE
  sharedCanvasContext = null
}

function hasPoorVisibleContent(image: HTMLImageElement) {
  const displayWidth = image.clientWidth || SAMPLE_SIZE
  const displayHeight = image.clientHeight || SAMPLE_SIZE
  if (Math.min(displayWidth, displayHeight) < MIN_SAMPLE_DISPLAY_SIZE) return false

  const context = getSharedCanvasContext()
  if (!context) return false

  context.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
  context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)

  let data: Uint8ClampedArray
  try {
    data = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
  } catch (error) {
    resetSharedCanvas()
    throw error
  }
  let visiblePixels = 0
  let minX = SAMPLE_SIZE
  let minY = SAMPLE_SIZE
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < SAMPLE_SIZE; y += 1) {
    for (let x = 0; x < SAMPLE_SIZE; x += 1) {
      const index = (y * SAMPLE_SIZE + x) * 4
      const alpha = data[index + 3]
      if (alpha < 24) continue

      visiblePixels += 1

      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  const totalPixels = SAMPLE_SIZE * SAMPLE_SIZE
  const visibleRatio = visiblePixels / totalPixels
  if (visibleRatio < 0.04) return true

  const boundsWidth = maxX - minX + 1
  const boundsHeight = maxY - minY + 1
  const boundsRatio = (boundsWidth * boundsHeight) / totalPixels
  if (boundsRatio < 0.16) return true

  return false
}

export function AddonIcon({
  name,
  logo,
  alt = '',
  className,
  textClassName,
  imageClassName,
}: AddonIconProps) {
  const [rejectedLogo, setRejectedLogo] = useState<string | null>(null)
  const fallbackLetter = (name || '').trim().charAt(0).toUpperCase() || '?'
  const usableLogo = logo && isUsableLogoSrc(logo) ? logo : null
  const shouldShowLogo = Boolean(usableLogo) && rejectedLogo !== usableLogo
  const shouldShowFallback = !shouldShowLogo

  return (
    <div data-theme-part="image-tile" className={cn('relative flex shrink-0 items-center justify-center rounded-xl bg-muted', className)}>
      {shouldShowFallback ? (
        <span className={cn('relative z-10 font-bold text-muted-foreground', textClassName)}>
          {fallbackLetter}
        </span>
      ) : null}
      {usableLogo && shouldShowLogo ? (
        <img
          loading="lazy"
          decoding="async"
          src={usableLogo}
          alt={alt}
          className={cn('absolute inset-0 z-10 h-full w-full rounded-[inherit] object-contain p-1', imageClassName)}
          onError={() => setRejectedLogo(usableLogo)}
          onLoad={(event) => {
            const image = event.currentTarget
            if (hasBadIconShape(image.naturalWidth, image.naturalHeight)) {
              setRejectedLogo(usableLogo)
              return
            }

            try {
              if (hasPoorVisibleContent(image)) {
                setRejectedLogo(usableLogo)
              }
            } catch {
              return
            }
          }}
        />
      ) : null}
    </div>
  )
}
