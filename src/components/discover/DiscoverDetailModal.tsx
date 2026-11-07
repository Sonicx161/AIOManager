import { lazy, Suspense, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import { ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, FileText, Link2, Plus, Send, Settings2, Star, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  fetchDiscoverAddon,
  fetchDiscoverAddons,
  getAddonResources,
  getConfigureUrl,
  lastUpdatedLabel,
  requiresConfiguration,
  RESOURCE_LABELS,
  type DiscoverAddon,
  type DiscoverAddonDetail,
} from '@/api/discover'
import { AddonLogo } from './AddonLogo'
import { useToast } from '@/hooks/use-toast'

const DiscoverMarkdown = lazy(() => import('./DiscoverMarkdown'))

const SIMILAR_LIMIT = 6
const SIMILAR_TTL = 10 * 60 * 1000
const _similarCache = new Map<string, { data: DiscoverAddon[]; ts: number }>()

interface DiscoverDetailModalProps {
  addon: DiscoverAddon | null
  open: boolean
  onOpenChange: (open: boolean) => void
  // Changes when the detail is opened fresh. A reopen with the same key (for example after a
  // child dialog closes) keeps the internal nav stack instead of resetting it.
  sessionKey?: number
  saved: boolean
  isSaved?: (addon: DiscoverAddon) => boolean
  onSave: (addon: DiscoverAddon) => void
  onDeploy: (addon: DiscoverAddon) => void
  onConfigure: (addon: DiscoverAddon) => void
  onInjectAIOStreams?: (addon: DiscoverAddon) => void
  hasAIOStreams?: boolean
  onOpenAddon?: (addon: DiscoverAddon) => void
}

export function DiscoverDetailModal({ addon, open, onOpenChange, sessionKey = 0, saved, isSaved, onSave, onDeploy, onConfigure, onInjectAIOStreams, hasAIOStreams }: DiscoverDetailModalProps) {
  const { toast } = useToast()
  const [detail, setDetail] = useState<DiscoverAddonDetail | null>(null)
  const [activeAddon, setActiveAddon] = useState<DiscoverAddon | null>(addon)
  const [navStack, setNavStack] = useState<Array<{ addon: DiscoverAddon }>>([])
  const scrollBodyRef = useRef<HTMLDivElement>(null)
  const lastSessionRef = useRef<number | null>(null)

  useEffect(() => {
    if (open && addon && lastSessionRef.current !== sessionKey) {
      lastSessionRef.current = sessionKey
      setActiveAddon(addon)
      setNavStack([])
    }
  }, [open, addon, sessionKey])

  const handleInternalNav = useCallback((next: DiscoverAddon) => {
    setActiveAddon(prev => {
      if (prev) setNavStack(stack => [...stack, { addon: prev }])
      return next
    })
    setDetail(null)
    setDescExpanded(false)
    setDocsExpanded(false)
    scrollBodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  const navigateTo = (index: number) => {
    if (index < 0 || index >= navStack.length) return
    const target = navStack[index].addon
    setNavStack(prev => prev.slice(0, index))
    setActiveAddon(target)
    setDetail(null)
    setDescExpanded(false)
    setDocsExpanded(false)
    scrollBodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const [loading, setLoading] = useState(false)
  const [descExpanded, setDescExpanded] = useState(false)
  const [docsExpanded, setDocsExpanded] = useState(false)
  const [similar, setSimilar] = useState<DiscoverAddon[]>([])
  const [loadingSimilar, setLoadingSimilar] = useState(false)
  const similarRef = useRef<HTMLDivElement>(null)

  const scrollSimilar = (dir: 1 | -1) => {
    const el = similarRef.current
    if (!el) return
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.9, 220), behavior: 'smooth' })
  }

  const navAddon = activeAddon ?? addon

  useEffect(() => {
    if (!open || !navAddon) return
    let active = true
    setDetail(null)
    setLoading(true)
    setDescExpanded(false)
    setDocsExpanded(false)
    fetchDiscoverAddon(navAddon.slug || navAddon.uuid)
      .then((d) => { if (active) setDetail(d) })
      .catch(() => { if (active) setDetail(null) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [open, navAddon])

  useEffect(() => {
    if (!open || !navAddon) return
    const key = navAddon.slug || navAddon.uuid
    const categorySlugs = (navAddon.categories ?? []).map((c) => c.slug).filter(Boolean).slice(0, 2)
    if (categorySlugs.length === 0) { setSimilar([]); return }

    const hit = _similarCache.get(key)
    if (hit && Date.now() - hit.ts < SIMILAR_TTL) { setSimilar(hit.data); return }

    let active = true
    const ctrl = new AbortController()
    setLoadingSimilar(true)
    Promise.all(
      categorySlugs.map((slug) =>
        fetchDiscoverAddons({ category: [slug], sortBy: 'stars', limit: 10 }, ctrl.signal)
          .then((r) => Array.isArray(r.addons) ? r.addons : [])
          .catch(() => [] as DiscoverAddon[]),
      ),
    )
      .then((lists) => {
        if (!active) return
        const seen = new Set<string>()
        seen.add(navAddon.uuid)
        if (navAddon.slug) seen.add(navAddon.slug)
        const merged: DiscoverAddon[] = []
        for (const a of lists.flat()) {
          if (!a?.uuid) continue
          if (seen.has(a.uuid) || (a.slug && seen.has(a.slug))) continue
          seen.add(a.uuid)
          if (a.slug) seen.add(a.slug)
          merged.push(a)
        }
        const limited = merged.slice(0, SIMILAR_LIMIT)
        _similarCache.set(key, { data: limited, ts: Date.now() })
        if (_similarCache.size > 50) {
          const firstKey = _similarCache.keys().next().value
          if (firstKey !== undefined) _similarCache.delete(firstKey)
        }
        setSimilar(limited)
      })
      .finally(() => { if (active) setLoadingSimilar(false) })

    return () => { active = false; ctrl.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, navAddon?.slug, navAddon?.uuid])

  const instances = useMemo(() => detail?.instances ?? [], [detail])

  const visibleSimilar = useMemo(() => {
    if (!navAddon || similar.length === 0) return []
    const excluded = new Set<string>([navAddon.uuid])
    if (navAddon.slug) excluded.add(navAddon.slug)
    for (const inst of instances) {
      excluded.add(inst.uuid)
      if (inst.slug) excluded.add(inst.slug)
    }
    return similar.filter((a) => !excluded.has(a.uuid) && !(a.slug && excluded.has(a.slug)))
  }, [similar, instances, navAddon])

  if (!navAddon) return null

  const view: DiscoverAddon = detail ?? navAddon
  const isViewSaved = isSaved?.(view) ?? saved
  const manifest = view.manifest ?? ({} as DiscoverAddon['manifest'])
  const name = manifest.name?.trim() || view.slug || 'Unknown Addon'
  const description = manifest.description?.trim() || ''
  const resources = getAddonResources(view)
  const needsConfig = requiresConfiguration(view)
  const configureUrl = getConfigureUrl(view)
  const documentation = detail?.documentation?.trim() || ''
  const updated = lastUpdatedLabel(view)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          '!grid-cols-none !gap-0 !p-0 flex flex-col overflow-hidden',
          '!max-w-full sm:!max-w-4xl sm:rounded-2xl bg-card text-card-foreground shadow-2xl ring-1 ring-border/30 max-h-[90vh]',
        )}
        hideClose
      >
        {/* Header Hero Banner with Ambient Glass Blur */}
        <div className="relative shrink-0 overflow-hidden bg-black text-white -mb-1" style={{ height: 'clamp(160px, 24vh, 240px)', transform: 'translateZ(0)' }}>
          {navStack.length > 0 && (
            <button
              type="button"
              data-theme-part="button"
              onClick={() => navigateTo(navStack.length - 1)}
              className="absolute left-2 top-2 sm:left-3 sm:top-3 z-30 inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/60 px-3 py-1 sm:px-4 sm:py-1.5 text-xs font-bold text-white shadow-xl backdrop-blur-md transition-all hover:bg-black/80 hover:scale-105 active:scale-95"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to {navStack[navStack.length - 1].addon.manifest?.name?.trim() || navStack[navStack.length - 1].addon.slug || 'Addon'}
            </button>
          )}
          {manifest.background && (
            <img
              src={manifest.background}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-cover filter blur-3xl opacity-50 scale-125"
            />
          )}

          {manifest.background ? (
            <img
              src={manifest.background}
              alt=""
              className="absolute inset-0 h-full w-full object-cover opacity-95 transition-opacity duration-300"
              style={{
                maskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 70%, rgba(0,0,0,0) 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 70%, rgba(0,0,0,0) 100%)',
              }}
            />
          ) : (
            <div className="absolute inset-0 bg-black/90" />
          )}

          <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/50 via-black/15 to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 left-0 w-3/5 bg-gradient-to-r from-black/60 via-black/20 to-transparent" />

          {/* Close button */}
          <button
            type="button"
            data-theme-part="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="absolute right-3 top-3 z-30 flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/90 shadow-lg backdrop-blur-sm transition-all hover:bg-black/75 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="sr-only">Close</span>
          </button>

          {/* Header Title + Badges overlay */}
          <div className="absolute inset-x-0 bottom-0 z-10 flex items-end gap-3 p-4 sm:p-7">
            <div className="flex h-14 w-14 sm:h-20 sm:w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/20 bg-black/60 shadow-2xl backdrop-blur-md">
              <AddonLogo src={manifest.logo} name={name} className="h-full w-full object-contain p-2" letterClassName="text-xl font-black text-white" />
            </div>

            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span data-theme-part="badge" className="rounded-md bg-amber-500/90 px-2 py-0.5 text-[11px] font-black text-black shadow flex items-center gap-1">
                  <Star className="h-3 w-3 fill-black text-black" />
                  {(view.stars ?? 0).toLocaleString()}
                </span>
                {needsConfig && (
                  <span data-theme-part="badge" className="rounded-md bg-warning/90 px-2 py-0.5 text-[11px] font-extrabold text-black shadow flex items-center gap-1">
                    <Settings2 className="h-3 w-3" />
                    Needs Config
                  </span>
                )}
                {resources.slice(0, 3).map((r) => (
                  <span key={r} data-theme-part="badge" className="rounded-md border border-white/20 bg-black/60 px-2 py-0.5 text-[11px] font-bold text-white backdrop-blur-md">
                    {RESOURCE_LABELS[r] ?? r}
                  </span>
                ))}
              </div>

              <DialogTitle className="truncate text-xl sm:text-2xl font-extrabold tracking-tight text-white sm:text-4xl drop-shadow-md">
                {name}
              </DialogTitle>
              {updated && <p className="text-xs text-white/70 font-medium">{updated}</p>}
            </div>
          </div>
        </div>

        {/* Scrollable Body */}
        <div ref={scrollBodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-8 space-y-4 sm:space-y-5">
          {description && (
            <div className="space-y-1.5">
              <p className={cn('text-xs sm:text-sm leading-relaxed text-foreground/90 font-medium', !descExpanded && 'line-clamp-4')}>{description}</p>
              {description.length > 280 && (
                <button type="button" data-theme-part="button" className="text-xs font-bold text-primary hover:underline" onClick={() => setDescExpanded((v) => !v)}>
                  {descExpanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          )}

          {view.categories?.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {view.categories.map((c) => (
                <span key={c.slug} data-theme-part="badge" className="rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 sm:px-3 sm:py-1 text-xs font-bold text-muted-foreground">
                  {c.name}
                </span>
              ))}
            </div>
          )}

          {loading && <Skeleton className="h-20 w-full rounded-xl" />}

          {documentation && (
            <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card/60 backdrop-blur-md overflow-hidden">
              <button
                type="button"
                data-theme-part="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 sm:px-4 sm:py-3 text-xs font-bold uppercase tracking-widest text-muted-foreground/80 hover:text-foreground"
                onClick={() => setDocsExpanded((v) => !v)}
              >
                <span className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  Documentation
                </span>
                <ChevronDown className={cn('h-4 w-4 transition-transform', docsExpanded && 'rotate-180')} />
              </button>
              {docsExpanded && (
                <div className="border-t border-border/40 px-3 py-3 sm:px-4 sm:py-4">
                  <Suspense fallback={<Skeleton className="h-16 w-full rounded-xl" />}>
                    <DiscoverMarkdown content={documentation} />
                  </Suspense>
                </div>
              )}
            </div>
          )}

          {instances.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                Other Instances ({instances.length})
              </p>
              <div className="space-y-2">
                {instances.map((inst) => {
                  const instName = inst.manifest?.name?.trim() || inst.slug || 'Unknown addon'
                  const instHost = (() => { try { return new URL(inst.manifestUrl).hostname.replace(/^www\./, '') } catch { return '' } })()
                  const instSaved = isSaved?.(inst) ?? false
                  const instConfigUrl = getConfigureUrl(inst)
                  const instNeedsConfig = requiresConfiguration(inst)
                  return (
                    <div key={inst.uuid} data-theme-part="panel" className="flex items-center gap-2 rounded-xl border border-border/40 bg-card/40 p-2 sm:gap-3 sm:p-3 shadow-sm transition-all hover:border-primary/40">
                      <AddonLogo src={inst.manifest?.logo} name={instName} className="h-8 w-8 sm:h-9 sm:w-9 shrink-0 rounded-xl" letterClassName="text-xs" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-foreground">{instName}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                          {instHost && <span className="truncate font-mono">{instHost}</span>}
                          <span className="flex shrink-0 items-center gap-0.5 font-semibold">
                            <Star className="h-3 w-3 fill-warning text-warning" />
                            {(inst.stars ?? 0).toLocaleString()}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        {instSaved ? (
                          <Tooltip content="In Library" side="top">
                            <Button size="sm" variant="subtle" disabled className="h-8 w-8 flex items-center justify-center p-0 rounded-lg">
                              <Check className="h-4 w-4" />
                            </Button>
                          </Tooltip>
                        ) : (
                          <Tooltip content={instNeedsConfig ? 'Save unconfigured' : 'Save to Library'} side="top">
                            <Button size="sm" variant="subtle" className="h-8 w-8 flex items-center justify-center p-0 rounded-lg" onClick={() => onSave(inst)}>
                              <Plus className="h-4 w-4" />
                            </Button>
                          </Tooltip>
                        )}
                        {instConfigUrl && (
                          <Tooltip content="Configure" side="top">
                            <Button size="sm" variant="subtle" className="h-8 w-8 flex items-center justify-center p-0 rounded-lg" onClick={() => onConfigure(inst)}>
                              <Settings2 className="h-4 w-4" />
                            </Button>
                          </Tooltip>
                        )}
                        <Tooltip content="Deploy to account(s)" side="top">
                          <Button size="sm" variant="subtle" className="h-8 w-8 flex items-center justify-center p-0 rounded-lg" onClick={() => onDeploy(inst)}>
                            <Send className="h-4 w-4" />
                          </Button>
                        </Tooltip>
                        <Tooltip content="Copy Link" side="top">
                          <Button size="sm" variant="subtle" className="h-8 w-8 flex items-center justify-center p-0 rounded-lg" onClick={() => { navigator.clipboard.writeText(inst.manifestUrl).catch(() => { }); toast({ title: 'Link Copied', description: 'Addon install URL copied to clipboard' }) }}>
                            <Link2 className="h-4 w-4" />
                          </Button>
                        </Tooltip>
                        {hasAIOStreams && onInjectAIOStreams && (
                          <Tooltip content="Add to AIOStreams" side="top">
                            <Button size="sm" variant="subtle" className="h-8 w-8 flex items-center justify-center p-0 rounded-lg" onClick={() => onInjectAIOStreams(inst)}>
                              <Layers className="h-4 w-4" />
                            </Button>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {(loadingSimilar || visibleSimilar.length > 0) && (
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/80">
                Similar Addons
              </p>
              {loadingSimilar ? (
                <div className="flex gap-3 overflow-hidden">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-24 w-44 sm:h-28 sm:w-52 shrink-0 rounded-xl" />
                  ))}
                </div>
              ) : (
                <div className="group/similar relative">
                  {visibleSimilar.length > 2 && (
                    <div className="absolute -top-7 right-0 flex items-center gap-1">
                      <button
                        type="button"
                        data-theme-part="button"
                        onClick={() => scrollSimilar(-1)}
                        className="flex h-6 w-6 items-center justify-center rounded-full border border-border/40 bg-muted/60 text-muted-foreground hover:text-foreground"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        data-theme-part="button"
                        onClick={() => scrollSimilar(1)}
                        className="flex h-6 w-6 items-center justify-center rounded-full border border-border/40 bg-muted/60 text-muted-foreground hover:text-foreground"
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  <div ref={similarRef} className="scrollbar-hide -mx-1 flex gap-3 overflow-x-auto px-1 pb-1 scroll-smooth">
                    {visibleSimilar.map((s) => {
                      const sName = s.manifest?.name?.trim() || s.slug || 'Unknown addon'
                      const sDesc = s.manifest?.description?.trim() || ''
                      return (
                        <div key={s.uuid} data-theme-part="addon-card" className="flex w-40 sm:w-48 md:w-52 shrink-0 cursor-pointer flex-col gap-1.5 sm:gap-2 rounded-xl border border-border/40 bg-card/50 p-2 sm:p-3 shadow-sm transition-all hover:border-primary/40 hover:shadow-md" onClick={() => handleInternalNav(s)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleInternalNav(s) } }}>
                          <div className="flex items-center gap-2.5 min-w-0">
                            <AddonLogo src={s.manifest?.logo} name={sName} className="h-8 w-8 rounded-lg" letterClassName="text-xs" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-bold text-foreground">{sName}</p>
                              <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-400">
                                ★ {(s.stars ?? 0).toLocaleString()}
                              </span>
                            </div>
                          </div>
                          {sDesc && <p className="line-clamp-2 text-xs leading-snug text-muted-foreground/80 font-medium">{sDesc}</p>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <a
            href={view.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-bold text-primary hover:underline pt-2"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            View on stremio-addons.net
          </a>
        </div>

        {/* Footer Actions */}
        <div data-theme-part="toolbar" className="flex flex-wrap items-center gap-2 p-3 sm:gap-3 sm:p-4 border-t border-border/40 bg-muted/20">
          {isViewSaved ? (
            <Button variant="subtle" className="flex-1 gap-2 rounded-xl font-bold" disabled>
              <Check className="h-4 w-4" />
              In Library
            </Button>
          ) : (
            <Button className="flex-1 gap-2 rounded-xl font-bold shadow-md" onClick={() => onSave(view)}>
              <Plus className="h-4 w-4" />
              {needsConfig ? 'Save anyway' : 'Save to Library'}
            </Button>
          )}
          {onDeploy && (
            <Button className="gap-2 rounded-xl font-bold shadow-md" onClick={() => onDeploy(view)}>
              <Send className="h-4 w-4" />
              Install
            </Button>
          )}
          {configureUrl && (
            <Button variant="outline" className="gap-2 rounded-xl font-bold" onClick={() => onConfigure(view)}>
              <Settings2 className="h-4 w-4" />
              Configure
            </Button>
          )}
          <Button variant="outline" className="gap-2 rounded-xl font-bold" onClick={() => { navigator.clipboard.writeText(view.url).catch(() => { }); toast({ title: 'Link Copied', description: 'Addon URL copied to clipboard' }) }}>
            <Link2 className="h-4 w-4" />
            Copy Link
          </Button>
          {hasAIOStreams && onInjectAIOStreams && (
            <Button variant="outline" className="gap-2 rounded-xl font-bold" onClick={() => onInjectAIOStreams(view)}>
              <Layers className="h-4 w-4" />
              AIOStreams
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
