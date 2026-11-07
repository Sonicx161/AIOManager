import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { ChevronDown, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { computeNavFit, resolveAvailableWidth, resolveNavVisibility } from '@/components/ui/priority-nav-fit'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export interface PriorityNavItem {
  id: string
  label: string
  match: (path: string) => boolean
}

interface FitState {
  measured: boolean
  overflow: boolean
  visibleCount: number
  swapped: boolean
}

interface PriorityPillNavProps<T extends PriorityNavItem> {
  items: T[]
  activePath: string
  renderItem: (item: T, active: boolean, slot: 'row' | 'ghost') => ReactElement
  renderMenuItem: (item: T, active: boolean) => ReactNode
  triggerClassName: (open: boolean) => string
  onNavigate?: (item: T) => void
  className?: string
  menuItemClassName?: string
  menuContentClassName?: string
  moreLabel?: string
}

// One-row pill nav: pills that do not fit move into a More pill. A ghost row
// renders every pill once so widths stay real (fonts, badges, themes); a
// ResizeObserver recomputes the split on width changes.
export function PriorityPillNav<T extends PriorityNavItem>({
  items,
  activePath,
  renderItem,
  renderMenuItem,
  triggerClassName,
  onNavigate,
  className,
  menuItemClassName,
  menuContentClassName,
  moreLabel = 'More',
}: PriorityPillNavProps<T>) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<FitState>({ measured: false, overflow: false, visibleCount: items.length, swapped: false })
  const [moreOpen, setMoreOpen] = useState(false)

  const measure = () => {
    const wrapper = wrapperRef.current
    const container = containerRef.current
    const ghost = ghostRef.current
    if (!wrapper || !container || !ghost) return
    const style = getComputedStyle(container)
    const gap = parseFloat(style.columnGap) || 0
    const chrome = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
      + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0)
    const wrapperStyle = getComputedStyle(wrapper)
    const wrapperPaddingX = (parseFloat(wrapperStyle.paddingLeft) || 0) + (parseFloat(wrapperStyle.paddingRight) || 0)
    const available = resolveAvailableWidth(wrapper.clientWidth, wrapperPaddingX, chrome)
    const moreGhost = ghost.querySelector<HTMLElement>('[data-priority-nav-more]')
    const pillEls = Array.from(ghost.children).filter(el => el !== moreGhost) as HTMLElement[]
    if (pillEls.length !== items.length) return
    const widths = pillEls.map(el => el.getBoundingClientRect().width)
    const moreWidth = moreGhost ? moreGhost.getBoundingClientRect().width : 0
    const activeIndex = items.findIndex(item => item.match(activePath))
    const result = computeNavFit({ available, widths, moreWidth, gap, activeIndex })
    setFit(prev => (prev.measured && prev.overflow === result.overflow && prev.visibleCount === result.visibleCount && prev.swapped === result.swapped
      ? prev
      : { measured: true, overflow: result.overflow, visibleCount: result.visibleCount, swapped: result.swapped }))
  }

  useLayoutEffect(() => {
    measure()
  })

  // A route change can add or remove the active pill's border, so a settled
  // split must be recomputed even when the ghost is not mounted.
  useLayoutEffect(() => {
    setFit(prev => (prev.measured ? { ...prev, measured: false } : prev))
  }, [activePath])

  useEffect(() => {
    const wrapper = wrapperRef.current
    const container = containerRef.current
    if (!wrapper || !container) return
    const restart = () => setFit(prev => (prev.measured ? { ...prev, measured: false } : prev))
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restart)
    // The wrapper is the stable width source; the w-fit container follows its content.
    resizeObserver?.observe(wrapper)
    const { fonts } = document
    fonts?.ready.then(restart)
    fonts?.addEventListener('loadingdone', restart)
    // Restart only for visible content changes; ghost churn is self-caused.
    const inGhost = (node: Node | null | undefined) => {
      if (!node) return false
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element | null
      return !!el && el.closest('[data-priority-nav-ghost]') !== null
    }
    const mutations = new MutationObserver(records => {
      const relevant = records.some(record => {
        if (inGhost(record.target)) return false
        const changed = [...record.addedNodes, ...record.removedNodes]
        return changed.length === 0 || changed.some(node => !inGhost(node))
      })
      if (relevant) restart()
    })
    mutations.observe(container, { childList: true, characterData: true, subtree: true })
    return () => {
      resizeObserver?.disconnect()
      fonts?.removeEventListener('loadingdone', restart)
      mutations.disconnect()
    }
  }, [])

  const activeIndex = items.findIndex(item => item.match(activePath))
  const { visible, hidden } = resolveNavVisibility(items, fit, activeIndex)
  const showGhost = !fit.measured || fit.overflow

  // A resize that clears the overflow unmounts the menu; a stale open state
  // would pop it back open when pills overflow again.
  useEffect(() => {
    if (hidden.length === 0) setMoreOpen(false)
  }, [hidden.length])
  const moreContent = (
    <>
      <MoreHorizontal className="h-[15px] w-[15px]" strokeWidth={1.7} />
      <span>{moreLabel}</span>
      <ChevronDown className="h-3 w-3" strokeWidth={2} />
    </>
  )

  return (
    <div ref={wrapperRef} className="flex w-full justify-center px-2">
      <div ref={containerRef} data-theme-part="app-nav" className={cn('relative w-fit max-w-full flex-nowrap', className)}>
        {visible.map(item => (
          <Fragment key={item.id}>{renderItem(item, item.match(activePath), 'row')}</Fragment>
        ))}
        {hidden.length > 0 && (
          <DropdownMenu open={moreOpen && hidden.length > 0} onOpenChange={setMoreOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-theme-part="nav-item"
                data-state={moreOpen ? 'open' : 'inactive'}
                aria-label={`More, ${hidden.length} ${hidden.length === 1 ? 'page' : 'pages'}`}
                className={triggerClassName(moreOpen)}
              >
                {moreContent}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={8} className={menuContentClassName}>
              {hidden.map(item => {
                const active = item.match(activePath)
                return (
                  <DropdownMenuItem
                    key={item.id}
                    aria-current={active ? 'page' : undefined}
                    className={menuItemClassName}
                    onClick={() => onNavigate?.(item)}
                  >
                    {renderMenuItem(item, active)}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {showGhost && (
          <div
            ref={ghostRef}
            data-priority-nav-ghost=""
            aria-hidden="true"
            inert
            className="pointer-events-none invisible absolute inset-y-0 left-0 flex flex-nowrap items-center"
          >
            {items.map(item => (
              <Fragment key={item.id}>{renderItem(item, item.match(activePath), 'ghost')}</Fragment>
            ))}
            <button
              type="button"
              data-theme-part="nav-item"
              data-state="inactive"
              data-priority-nav-more
              tabIndex={-1}
              className={triggerClassName(false)}
            >
              {moreContent}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
