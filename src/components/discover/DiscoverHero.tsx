import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Check, ChevronLeft, ChevronRight, Layers, Plus, Send, Settings2, Star } from 'lucide-react'
import { getConfigureUrl, requiresConfiguration, type DiscoverAddon } from '@/api/discover'

interface DiscoverHeroProps {
  addons: DiscoverAddon[]
  isSaved: (addon: DiscoverAddon) => boolean
  savingKey: string | null
  onSave: (addon: DiscoverAddon) => void
  onConfigure: (addon: DiscoverAddon) => void
  onOpenDetail: (addon: DiscoverAddon) => void
  onDeploy?: (addon: DiscoverAddon) => void
  deployedCount?: (addon: DiscoverAddon) => number
  accountTotal?: number
  hasAIOStreams?: boolean
  onInjectAIOStreams?: (addon: DiscoverAddon) => void
}

const ROTATE_MS = 7000

export function DiscoverHero({ addons, isSaved, savingKey, onSave, onConfigure, onOpenDetail, onDeploy, deployedCount, hasAIOStreams, onInjectAIOStreams }: DiscoverHeroProps) {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [failedBackgrounds, setFailedBackgrounds] = useState<Set<string>>(new Set())
  const [failedLogos, setFailedLogos] = useState<Set<string>>(new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const [onScreen, setOnScreen] = useState(true)
  const [tabHidden, setTabHidden] = useState(() => document.hidden)

  const count = addons.length
  const active = count > 0 ? index % count : 0

  useEffect(() => { setIndex(0) }, [count])

  useEffect(() => {
    const onChange = () => setTabHidden(document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  const mounted = count > 0
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting))
    observer.observe(el)
    return () => observer.disconnect()
  }, [mounted])

  useEffect(() => {
    if (paused || !onScreen || tabHidden || count <= 1) return
    const id = setInterval(() => setIndex((i) => (i + 1) % count), ROTATE_MS)
    return () => clearInterval(id)
  }, [paused, onScreen, tabHidden, count])

  if (count === 0) return null

  const go = (delta: number) => setIndex((i) => (i + delta + count) % count)

  const addon = addons[active]
  const manifest = addon.manifest ?? ({} as DiscoverAddon['manifest'])
  const name = manifest.name?.trim() || addon.slug
  const description = manifest.description?.trim() || ''
  const background = manifest.background
  const logo = manifest.logo
  const needsConfig = requiresConfiguration(addon)
  const canConfigure = !!getConfigureUrl(addon)
  const saved = isSaved(addon)
  const deployedOn = deployedCount?.(addon) ?? 0
  
  const showBackground = background && !failedBackgrounds.has(addon.uuid)
  const showLogo = logo && !failedLogos.has(addon.uuid)

  return (
    <div
      ref={rootRef}
      data-theme-part="addon-card"
      className="group relative w-full overflow-hidden rounded-3xl bg-background text-foreground shadow-2xl ring-1 ring-border/30 cursor-pointer"
      style={{ height: 'clamp(280px, 36vh, 380px)' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onClick={() => onOpenDetail(addon)}
    >
      <div className="absolute inset-0 bg-black" aria-hidden="true" />

      {showBackground && (
        <img
          src={background!}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover filter blur-3xl opacity-50 scale-125"
        />
      )}

      {/* Primary Hero Backdrop */}
      <AnimatePresence mode="wait">
        <motion.div
          key={addon.uuid}
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="absolute inset-0 bg-black"
        >
          {showBackground ? (
            <img
              src={background!}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover opacity-95 transition-opacity duration-300"
              style={{
                maskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 70%, rgba(0,0,0,0) 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 70%, rgba(0,0,0,0) 100%)',
              }}
              onError={() => setFailedBackgrounds(prev => new Set(prev).add(addon.uuid))}
            />
          ) : (
            <div className="absolute inset-0 bg-black/90" />
          )}
        </motion.div>
      </AnimatePresence>

      <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/50 via-black/15 to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 left-0 w-3/5 bg-gradient-to-r from-black/60 via-black/20 to-transparent" />

      {/* Hero Content */}
      <div className="relative flex h-full flex-col justify-end gap-3 px-6 pb-8 pt-10 sm:px-10 max-w-3xl">
        <motion.div
          key={`${addon.uuid}-content`}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          className="flex flex-col gap-3"
        >
          <div className="flex items-center gap-3.5">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/20 bg-black/60 shadow-xl backdrop-blur-md">
              {showLogo ? (
                <img
                  src={logo!}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-contain p-1.5"
                  onError={() => setFailedLogos(prev => new Set(prev).add(addon.uuid))}
                />
              ) : (
                <span className="text-xl font-bold text-white">{name.charAt(0).toUpperCase()}</span>
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span data-theme-part="badge" className="rounded-md bg-primary/85 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-widest text-primary-foreground shadow-sm">
                  Spotlight
                </span>
                <span data-theme-part="badge" className="rounded-md bg-amber-500/90 px-2 py-0.5 text-[11px] font-black text-black shadow flex items-center gap-1">
                  <Star className="h-3 w-3 fill-black text-black" />
                  {(addon.stars ?? 0).toLocaleString()}
                </span>
                {deployedOn > 0 && (
                  <span data-theme-part="badge" className="rounded-md border border-white/20 bg-black/60 px-2 py-0.5 text-[11px] font-bold text-white backdrop-blur-md flex items-center gap-1">
                    <Send className="h-3 w-3" />
                    On {deployedOn} account{deployedOn !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <h2 className="truncate text-2xl font-extrabold tracking-tight text-white sm:text-4xl drop-shadow-lg font-black">{name}</h2>
            </div>
          </div>

          {description && (
            <p className="max-w-2xl text-sm leading-relaxed text-white/80 line-clamp-2 font-medium drop-shadow">
              {description}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {needsConfig ? (
              <Button className="h-10 rounded-full px-6 font-bold gap-2 shadow-lg" onClick={() => onConfigure(addon)}>
                <Settings2 className="h-4 w-4" />
                Configure
              </Button>
            ) : onDeploy ? (
              <Button className="h-10 rounded-full px-6 font-bold gap-2 shadow-lg" onClick={() => onDeploy(addon)}>
                <Send className="h-4 w-4" />
                Install to Accounts
              </Button>
            ) : (
              <Button className="h-10 rounded-full px-6 font-bold gap-2 shadow-lg" onClick={() => onSave(addon)} disabled={savingKey === addon.uuid}>
                <Plus className="h-4 w-4" />
                {savingKey === addon.uuid ? 'Saving...' : 'Save to Library'}
              </Button>
            )}
            {saved ? (
              <Button variant="outline" disabled className="h-10 rounded-full border-white/20 bg-white/10 px-5 font-semibold text-white backdrop-blur-md gap-2">
                <Check className="h-4 w-4" />
                In Library
              </Button>
            ) : !needsConfig && onDeploy ? (
              <Button variant="outline" className="h-10 rounded-full border-white/20 bg-white/10 px-5 font-semibold text-white backdrop-blur-md hover:bg-white/20 gap-2" onClick={() => onSave(addon)} disabled={savingKey === addon.uuid}>
                <Plus className="h-4 w-4" />
                {savingKey === addon.uuid ? 'Saving...' : 'Save'}
              </Button>
            ) : null}
            {!needsConfig && canConfigure && (
              <Button variant="outline" className="gap-1.5" onClick={() => onConfigure(addon)}>
                <Settings2 className="h-4 w-4" />
                Configure
              </Button>
            )}
            {hasAIOStreams && onInjectAIOStreams && (
              <Button variant="outline" className="gap-1.5" onClick={() => onInjectAIOStreams(addon)}>
                <Layers className="h-4 w-4" />
                Add to AIOStreams
              </Button>
            )}
          </div>
        </motion.div>
      </div>

      {count > 1 && (
        <>
          <button
            type="button"
            data-theme-part="button"
            aria-label="Previous featured addon"
            onClick={(e) => { e.stopPropagation(); go(-1) }}
            className="absolute left-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-border/40 bg-card/70 text-foreground/80 shadow-lg backdrop-blur transition-colors hover:bg-card"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            data-theme-part="button"
            aria-label="Next featured addon"
            onClick={(e) => { e.stopPropagation(); go(1) }}
            className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-border/40 bg-card/70 text-foreground/80 shadow-lg backdrop-blur transition-colors hover:bg-card"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          <div className="absolute bottom-3 right-4 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {addons.map((a, i) => (
              <button
                key={a.uuid}
                type="button"
                aria-label={`Spotlight ${i + 1}`}
                onClick={() => setIndex(i)}
                className={cn('h-1.5 rounded-full transition-all', i === active ? 'w-5 bg-primary' : 'w-1.5 bg-foreground/30 hover:bg-foreground/50')}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
