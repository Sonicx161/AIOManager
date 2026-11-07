import { useCallback, useEffect, useRef, useState } from 'react'
import { animate, motion, useMotionValue, useTransform, type PanInfo } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { ArrowRight, Circle, Crown, Gem, Info, Loader2, Plus, RotateCcw, Send, Shield, Sparkles, Star, Undo2 } from 'lucide-react'
import { getAddonResources, RESOURCE_LABELS, type DiscoverAddon } from '@/api/discover'
import { getRarity, getRarityConfig, countByRarity, type RarityTier } from './rarity'
import { useConfetti } from '@/components/ui/confetti'
import { AddonLogo } from './AddonLogo'
import { isKeyboardSyntheticTap } from './deck-input'

const SWIPE_THRESHOLD = 110
export const DECK_CARD_CLASS = 'relative aspect-[7/10] h-[clamp(15rem,calc(100dvh_-_26rem_-_env(safe-area-inset-bottom,0px)),32rem)] sm:h-[clamp(18rem,calc(100dvh_-_29rem),44rem)] max-w-full'

interface DiscoverDeckProps {
  pool: DiscoverAddon[]
  loading: boolean
  onReshuffle: () => void
  isSaved: (addon: DiscoverAddon) => boolean
  savingKey: string | null
  onSave: (addon: DiscoverAddon) => void
  onOpenDetail: (addon: DiscoverAddon) => void
  onDeploy?: (addon: DiscoverAddon) => void
  deployedCount?: (addon: DiscoverAddon) => number
  accountTotal?: number
}

function DeckBackdrop({ offset }: { offset: number }) {
  return (
    <div
      data-theme-part="addon-card"
      className="absolute inset-0 -z-10 overflow-hidden rounded-3xl border border-border/40 bg-card shadow-lg"
      style={{ transform: `scale(${1 - offset * 0.04}) translateY(${offset * 14}px)`, opacity: 1 - offset * 0.6 }}
      aria-hidden
    />
  )
}

function RarityGem({ tier, className, style }: { tier: RarityTier; className?: string; style?: React.CSSProperties }) {
  const Icon = { common: Circle, rare: Shield, epic: Gem, legendary: Crown }[tier]
  return <Icon className={className} style={style} />
}

function CardBack() {
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-muted to-card">
      <div className="absolute inset-0 opacity-5" style={{
        backgroundImage: 'radial-gradient(circle at 25% 25%, currentColor 1px, transparent 1px), radial-gradient(circle at 75% 75%, currentColor 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }} />
      <Sparkles className="h-12 w-12 text-muted-foreground/40" />
      <p className="mt-3 text-sm font-medium text-muted-foreground/60">Tap to reveal</p>
    </div>
  )
}

function DeckFace({ addon, saved, deployedOn, prefersReducedMotion }: { addon: DiscoverAddon; saved: boolean; deployedOn: number; prefersReducedMotion: boolean }) {
  const manifest = addon.manifest ?? ({} as DiscoverAddon['manifest'])
  const name = manifest.name?.trim() || addon.slug || 'Unknown Addon'
  const description = manifest.description?.trim() || 'No description provided.'
  const types = Array.isArray(manifest.types) ? manifest.types.filter((t): t is string => typeof t === 'string') : []
  const resources = getAddonResources(addon)
  const background = manifest.background
  const [imgError, setImgError] = useState(false)
  const rarity = getRarityConfig(addon.stars)

  return (
    <div
      data-theme-part="addon-card"
      className="relative flex h-full select-none flex-col rounded-3xl bg-card"
      style={{
        border: `2px solid ${rarity.color}50`,
        boxShadow: `0 0 0 1px ${rarity.color}20, 0 12px 40px ${rarity.glowColor}, inset 0 0 20px ${rarity.color}08`,
        padding: '6px',
      }}
    >
      <style>{`@keyframes holo-shimmer { 0% { transform: translateX(-30%) } 50% { transform: translateX(30%) } 100% { transform: translateX(-30%) } } .holo-shimmer { animation: holo-shimmer 4s ease-in-out infinite }`}</style>

      <div
        className="relative flex-1 overflow-hidden rounded-2xl"
        style={{ border: `1px solid ${rarity.color}25`, minHeight: '50%' }}
      >
        {background && !imgError ? (
          <img src={background} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" loading="lazy" onError={() => setImgError(true)} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${rarity.color}25, ${rarity.color}05)` }}>
            <AddonLogo src={manifest.logo} name={name} className="h-20 w-20 rounded-3xl opacity-60 sm:h-24 sm:w-24" letterClassName="text-2xl" />
          </div>
        )}

        {rarity.shimmer && !prefersReducedMotion && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
            <div className="holo-shimmer absolute -inset-[100%]" style={{
              opacity: 0.35,
              background: getRarity(addon.stars) === 'legendary'
                ? 'linear-gradient(115deg, transparent 20%, rgba(245,158,11,0.25) 30%, rgba(168,85,247,0.25) 40%, rgba(59,130,246,0.25) 50%, rgba(245,158,11,0.25) 60%, transparent 70%)'
                : `linear-gradient(115deg, transparent 25%, ${rarity.color}50 45%, ${rarity.color}30 55%, transparent 70%)`,
            }} />
          </div>
        )}

        {saved && (
          <div data-theme-part="badge" className="absolute right-2 top-2 rounded-full bg-emerald-500/90 px-2 py-0.5 text-[10px] font-semibold text-white shadow-md">In Library</div>
        )}
      </div>

      <div className="flex items-center gap-2 px-1 pt-2.5 pb-1.5">
        <RarityGem tier={getRarity(addon.stars)} className="h-5 w-5 shrink-0" style={{ color: rarity.color }} />
        <h3 className="min-w-0 flex-1 truncate text-base font-bold tracking-tight sm:text-lg">{name}</h3>
        <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-muted-foreground">
          <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
          {(addon.stars ?? 0).toLocaleString()}
        </span>
      </div>

      <p className="px-1 pb-1 text-xs leading-relaxed text-muted-foreground line-clamp-2">{description}</p>

      <div className="rounded-xl bg-black/10 p-2 dark:bg-black/25">
        <div className="flex flex-wrap items-center gap-1">
          {resources.map((r) => (
            <span key={r} data-theme-part="badge" className="rounded-md border border-border/30 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium">{RESOURCE_LABELS[r] ?? r}</span>
          ))}
          {types.slice(0, 3).map((t) => (
            <span key={t} data-theme-part="badge" className="rounded-md bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium capitalize opacity-60">{t}</span>
          ))}
        </div>
        {deployedOn > 0 && (
          <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Send className="h-2.5 w-2.5" />
            On {deployedOn} account{deployedOn !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-1 pt-1.5 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/60">
        <span style={{ color: rarity.color }}>{rarity.label}</span>
        <span className="max-w-[50%] truncate">{addon.slug}</span>
      </div>
    </div>
  )
}

export function DiscoverDeck({ pool, loading, onReshuffle, isSaved, savingKey, onSave, onOpenDetail, onDeploy, deployedCount, accountTotal }: DiscoverDeckProps) {
  const [index, setIndex] = useState(0)
  const [flinging, setFlinging] = useState(false)
  const [history, setHistory] = useState<Array<{ index: number }>>([])
  const [revealed, setRevealed] = useState(false)
  const [flipFlash, setFlipFlash] = useState(false)
  const draggedRef = useRef(false)
  const x = useMotionValue(0)
  const rotate = useTransform(x, [-220, 0, 220], [-12, 0, 12])
  const confetti = useConfetti()
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const current = pool[index]
  const upcoming = pool[index + 1]
  const afterNext = pool[index + 2]
  const deployedOn = current ? deployedCount?.(current) ?? 0 : 0
  const onAllAccounts = !!accountTotal && accountTotal > 0 && deployedOn >= accountTotal

  useEffect(() => {
    for (let i = index + 1; i <= index + 3; i++) {
      const bg = pool[i]?.manifest?.background
      if (bg) { const img = new Image(); img.src = bg }
    }
  }, [pool, index])

  const flip = useCallback(() => {
    if (revealed || flinging) return
    setRevealed(true)
    setFlipFlash(true)
    if (current) {
      const rarity = getRarityConfig(current.stars)
      if (rarity.confetti && !prefersReducedMotion) {
        confetti.fire({
          particleCount: getRarity(current.stars) === 'legendary' ? 80 : 50,
          spread: 70,
          origin: { x: 0.5, y: 0.4 },
          colors: rarity.confettiColors,
        })
      }
    }
  }, [revealed, flinging, current, prefersReducedMotion, confetti])

  const next = useCallback((flyDir: number = 520) => {
    if (flinging) return
    setRevealed(false)
    setFlipFlash(false)
    setHistory((h) => [...h, { index }])
    setFlinging(true)
    animate(x, flyDir, {
      duration: 0.3,
      ease: 'easeOut',
      onComplete: () => { setIndex((i) => i + 1); x.set(0); setFlinging(false) },
    })
  }, [flinging, x, index])

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    if (Math.abs(info.offset.x) > SWIPE_THRESHOLD || Math.abs(info.velocity.x) > 500) {
      navigator.vibrate?.(10)
      next((info.offset.x || info.velocity.x) > 0 ? 520 : -520)
    }
  }

  const undo = useCallback(() => {
    if (flinging) return
    setHistory((h) => {
      if (h.length === 0) return h
      const last = h[h.length - 1]
      x.set(0)
      setIndex(last.index)
      setRevealed(true)
      return h.slice(0, -1)
    })
  }, [flinging, x])

  const handleSave = useCallback(() => {
    if (!current || savingKey === current.uuid || isSaved(current)) return
    onSave(current)
  }, [current, savingKey, isSaved, onSave])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (document.querySelector('[role="dialog"][data-state="open"]')) return
      if (e.key === 'Backspace') { e.preventDefault(); undo(); return }
      const addon = pool[index]
      if (!addon) return
      const key = e.key.toLowerCase()
      if (e.key === 'ArrowRight') { e.preventDefault(); next() }
      else if (e.key === ' ' || key === 'f') { e.preventDefault(); if (!revealed) flip() }
      else if (e.key === 'Enter' && !revealed) {
        if (t?.tagName !== 'BUTTON' && t?.tagName !== 'A') { e.preventDefault(); flip() }
      }
      else if (e.key === 'ArrowUp' || e.key === 'Enter' || key === 'i') { if (revealed) { e.preventDefault(); onOpenDetail(addon) } }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pool, index, next, undo, onOpenDetail, revealed, flip])

  const reset = () => { setIndex(0); setHistory([]); onReshuffle() }

  if (loading && pool.length === 0) {
    return (
      <div className="flex h-[clamp(22rem,55vh,32rem)] sm:h-[clamp(28rem,70vh,44rem)] flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <p className="text-sm">Unwrapping your collection...</p>
      </div>
    )
  }

  if (!loading && pool.length === 0) {
    return (
      <div className="flex h-[clamp(22rem,55vh,32rem)] sm:h-[clamp(28rem,70vh,44rem)] flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <Sparkles className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm">Nothing to surface right now. Try again in a bit.</p>
        <Button variant="outline" size="sm" onClick={reset} className="gap-1.5"><RotateCcw className="h-4 w-4" /> Reshuffle</Button>
      </div>
    )
  }

  if (!current) {
    return (
      <div className="flex h-[clamp(22rem,55vh,32rem)] sm:h-[clamp(28rem,70vh,44rem)] flex-col items-center justify-center gap-3 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <Sparkles className="h-8 w-8 text-primary" />
        </div>
        <p className="text-base font-semibold">Collection complete!</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          You discovered {(() => { const c = countByRarity(pool); return [c.epic && `${c.epic} Epics`, c.legendary && `${c.legendary} Legendaries`].filter(Boolean).join(' and ') })() || 'some great addons'}. Favorites are saved in your Discover shelf.
        </p>
        <Button onClick={reset} className="gap-1.5"><RotateCcw className="h-4 w-4" /> Shuffle a fresh deck</Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-6 sm:gap-7">
      {/* Card height is the viewport minus the chrome above and the toolbar below (plus bottom nav and safe area on phones),
          so the actions stay visible; width follows the 7:10 aspect. */}
      <div className={DECK_CARD_CLASS}>
        {afterNext && <DeckBackdrop offset={2} />}
        {upcoming && <DeckBackdrop offset={1} />}
        <motion.div
          key={current.uuid}
          className="absolute inset-0 cursor-grab active:cursor-grabbing"
          style={{ x, rotate, touchAction: 'none' }}
          drag="x"
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.7}
          onDragEnd={handleDragEnd}
          onPointerDownCapture={() => { draggedRef.current = false }}
          onDragStart={() => { draggedRef.current = true }}
          onTap={(e) => { if (draggedRef.current || isKeyboardSyntheticTap(e as PointerEvent)) return; if (!revealed) flip(); else onOpenDetail(current) }}
          initial={{ scale: 0.95, y: 12 }}
          animate={{ scale: 1, y: 0 }}
          transition={prefersReducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 400, damping: 28 }}
        >
          <motion.div
            className="absolute inset-0"
            style={{ transformStyle: 'preserve-3d' }}
            initial={false}
            animate={{ rotateY: revealed ? 0 : 180 }}
            transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.6, ease: 'easeInOut' }}
          >
            <div className="absolute inset-0" style={{ backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', opacity: revealed ? 1 : 0 }}>
              <DeckFace addon={current} saved={isSaved(current)} deployedOn={deployedOn} prefersReducedMotion={prefersReducedMotion} />
            </div>
            <div className="absolute inset-0" style={{ backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}>
              <CardBack />
            </div>
          </motion.div>
          {flipFlash && current && getRarityConfig(current.stars).shimmer && !prefersReducedMotion && (
            <motion.div
              className="pointer-events-none absolute inset-0 z-50 rounded-3xl"
              style={{ background: `radial-gradient(circle at center, ${getRarityConfig(current.stars).color}60, transparent 70%)` }}
              initial={{ opacity: 0.9 }}
              animate={{ opacity: 0 }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
              onAnimationComplete={() => setFlipFlash(false)}
            />
          )}
        </motion.div>
      </div>

      <div data-theme-part="toolbar" className="flex items-center gap-2.5 sm:gap-3 rounded-2xl border border-border/40 bg-card p-3 shadow-sm">
        <Tooltip content="Undo" side="bottom">
          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 rounded-full shadow-sm transition-transform hover:scale-105 disabled:opacity-40 disabled:hover:scale-100"
            onClick={undo}
            disabled={history.length === 0}
            aria-label="Undo last"
          >
            <Undo2 className="h-5 w-5" />
          </Button>
        </Tooltip>
        <Tooltip content="Details" side="bottom">
          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 rounded-full shadow-sm transition-transform hover:scale-105 disabled:opacity-40 disabled:hover:scale-100"
            onClick={() => onOpenDetail(current)}
            disabled={!revealed}
            aria-label="Details"
          >
            <Info className="h-5 w-5" />
          </Button>
        </Tooltip>
        {onDeploy && (
          <Tooltip content={onAllAccounts ? 'On all accounts' : 'Install to accounts'} side="bottom">
            <Button
              variant="outline"
              size="icon"
              className="h-12 w-12 rounded-full shadow-sm transition-transform hover:scale-105 disabled:opacity-40 disabled:hover:scale-100"
              onClick={() => onDeploy(current)}
              disabled={!revealed || onAllAccounts}
              aria-label="Install to accounts"
            >
              <Send className="h-5 w-5" />
            </Button>
          </Tooltip>
        )}
        <Tooltip content={isSaved(current) ? 'In Library' : 'Save to Library'} side="bottom">
          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 rounded-full shadow-sm transition-transform hover:scale-105 disabled:opacity-40 disabled:hover:scale-100"
            onClick={handleSave}
            disabled={!revealed || isSaved(current) || savingKey === current.uuid}
            aria-label="Save to library"
          >
            {savingKey === current.uuid ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plus className="h-5 w-5" />}
          </Button>
        </Tooltip>
        <Tooltip content="Next card" side="bottom">
          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 rounded-full shadow-sm transition-transform hover:scale-105"
            onClick={() => next()}
            aria-label="Next card"
          >
            <ArrowRight className="h-5 w-5" />
          </Button>
        </Tooltip>
      </div>

      <p className="text-xs text-muted-foreground">
        {!revealed ? 'tap to reveal' : 'tap for details'} · drag or use Next to browse
      </p>
    </div>
  )
}
