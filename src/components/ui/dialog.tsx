import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { X } from 'lucide-react'
import { getLastActivated, pickReturnFocus, trackActivations } from './dialog-focus'
import { acquireScrollLock, releaseScrollLock } from './dialog-scroll-lock'
import { drillBack, drillForward, drillPush, initDrillHistory } from '@/lib/drill-history'
import { dispatchAltNav, hostOwnsKeyEvent, type DialogNavEntry } from '@/lib/dialog-nav'

if (typeof document !== 'undefined') trackActivations(document)

// Open sheets in open order; the last entry is the topmost dialog. Used to keep
// a nested dialog's keys from also reaching the dialog it was opened over.
const openNavHosts: Array<{ rootRef: React.RefObject<HTMLDivElement | null> }> = []

const DialogContext = React.createContext<{ onOpenChange?: (open: boolean) => void; titleId?: string; backStack?: React.MutableRefObject<Array<() => void>>; navStack?: React.MutableRefObject<DialogNavEntry[]> }>({})

/**
 * While active (a sheet showing a sub-page), Escape calls onBack instead of closing the dialog.
 * Registrations stack, so the page opened last goes back first.
 */
function useDialogBack(active: boolean, onBack: () => void) {
  const { backStack } = React.useContext(DialogContext)
  const latest = React.useRef(onBack)
  latest.current = onBack
  React.useEffect(() => {
    if (!backStack || !active) return
    const entry = () => latest.current()
    backStack.current.push(entry)
    return () => { backStack.current = backStack.current.filter(e => e !== entry) }
  }, [backStack, active])
}

/** For components that render the Dialog themselves and so cannot call useDialogBack above it. */
function DialogBack({ active, onBack }: { active: boolean; onBack: () => void }) {
  useDialogBack(active, onBack)
  return null
}

/**
 * Back/forward history for drill-down sheets with simple page state (vault key
 * pages, connection panels): the same bounded model the Activity detail sheet
 * uses. Going back keeps the popped page on a forward stack; a new push clears
 * it. Both stacks cap at 12 entries, and every transition pulls focus back to
 * the sheet container so Escape and the tab trap keep working after a page
 * unmounts the focused control.
 */
function useDrillHistory<Page>(initial: Page | Page[], options?: { containerRef?: React.RefObject<HTMLElement | null> }) {
  const [state, setState] = React.useState(() => initDrillHistory(initial))
  const page = state.stack[state.stack.length - 1]
  const containerRef = options?.containerRef
  const focusContainer = React.useCallback(() => {
    if (containerRef) requestAnimationFrame(() => containerRef.current?.focus({ preventScroll: true }))
  }, [containerRef])
  const go = React.useCallback((next: Page) => {
    setState(s => drillPush(s, next))
    focusContainer()
  }, [focusContainer])
  const back = React.useCallback(() => {
    setState(s => drillBack(s))
    focusContainer()
  }, [focusContainer])
  const goForward = React.useCallback(() => {
    setState(s => drillForward(s))
    focusContainer()
  }, [focusContainer])
  const reset = React.useCallback((next: Page | Page[]) => {
    setState(initDrillHistory(next))
  }, [])
  return { page, canBack: state.stack.length > 1, canForward: state.forward.length > 0, go, back, goForward, reset }
}

/**
 * Alt+Left/Right history inside an open sheet: the keyboard half of the shared
 * drill model. Owners register into the dialog's single navStack (the mirror of
 * useDialogBack's backStack) and stay registered while either Back or Forward
 * is available, so a list holding just a Forward entry still gets Alt+Right.
 */
function useAltArrowHistory(active: boolean, canBack: boolean, canForward: boolean, onBack: () => void, onForward: () => void) {
  const { navStack } = React.useContext(DialogContext)
  const latest = React.useRef({ canBack, canForward, onBack, onForward })
  latest.current = { canBack, canForward, onBack, onForward }
  React.useEffect(() => {
    if (!navStack || !active) return
    const entry: DialogNavEntry = {
      canBack: () => latest.current.canBack,
      canForward: () => latest.current.canForward,
      back: () => latest.current.onBack(),
      forward: () => latest.current.onForward(),
    }
    navStack.current.push(entry)
    // Snapshot the array pushed to so cleanup unregisters from that same array
    // even if the context ref is swapped to a new one before unmount.
    const stack = navStack.current
    return () => {
      const at = stack.indexOf(entry)
      if (at >= 0) stack.splice(at, 1)
    }
  }, [navStack, active])
}

/** For components that render the Dialog themselves and so cannot call useAltArrowHistory above it. */
function DialogAltHistory({ active, canBack, canForward, onBack, onForward }: { active: boolean; canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void }) {
  useAltArrowHistory(active, canBack, canForward, onBack, onForward)
  return null
}

interface DialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
  describedBy?: string
}

const Dialog = ({ open, onOpenChange, children, describedBy }: DialogProps) => {
  const [mounted, setMounted] = React.useState(false)
  const [visible, setVisible] = React.useState(false)
  const titleId = React.useId()
  const dialogRef = React.useRef<HTMLDivElement>(null)
  const returnFocusRef = React.useRef<HTMLElement | null>(null)
  const backStack = React.useRef<Array<() => void>>([])
  const navStack = React.useRef<DialogNavEntry[]>([])

  // Alt+Left/Right goes to the deepest history owner of the topmost dialog holding the target.
  React.useEffect(() => {
    if (!open) return
    navStack.current.length = 0
    const host = { rootRef: dialogRef }
    openNavHosts.push(host)
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
      if (e.defaultPrevented) return
      const target = e.target
      const pageLevel = target === document.body || target === document.documentElement || target === document
      if (!hostOwnsKeyEvent(host, openNavHosts, target instanceof Node ? target : null, pageLevel)) return
      e.preventDefault()
      e.stopPropagation()
      dispatchAltNav(navStack.current, e.key)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const at = openNavHosts.indexOf(host)
      if (at >= 0) openNavHosts.splice(at, 1)
    }
  }, [open])

  React.useEffect(() => {
    if (open) {
      // Capture before the content mounts: an autoFocus child would otherwise be taken as the trigger.
      returnFocusRef.current = pickReturnFocus(
        [document.activeElement as HTMLElement | null, getLastActivated()],
        el => el !== document.body && !dialogRef.current?.contains(el),
      )
      setMounted(true)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true))
      })
      acquireScrollLock({ innerWidth: window.innerWidth, documentElement: document.documentElement })
      return () => {
        releaseScrollLock({ innerWidth: window.innerWidth, documentElement: document.documentElement })
      }
    } else {
      setVisible(false)
      const timer = setTimeout(() => setMounted(false), 200)
      return () => clearTimeout(timer)
    }
  }, [open])

  React.useEffect(() => {
    if (!open || !mounted) return
    const container = dialogRef.current
    if (!container) return
    requestAnimationFrame(() => {
      const preferredFocus = container.querySelector<HTMLElement>('[data-autofocus="true"], [autofocus]')
      if (preferredFocus) {
        preferredFocus.focus({ preventScroll: true })
        return
      }
      const active = document.activeElement
      if (active && active !== container && container.contains(active)) return
      container.focus({ preventScroll: true })
    })
    return () => {
      const target = returnFocusRef.current
      if (target?.isConnected) target.focus()
    }
  }, [open, mounted])

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      // A menu or popover inside the dialog already handled this Escape.
      if (e.defaultPrevented) return
      const back = backStack.current[backStack.current.length - 1]
      if (back) {
        back()
        return
      }
      onOpenChange?.(false)
    }
  }, [onOpenChange])

  // Capture phase, so a control that stops key propagation cannot let Tab leave the modal.
  const handleTabCapture = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      const container = dialogRef.current
      // React routes a nested (portaled) dialog's keys through this handler too; that dialog traps its own.
      if (!container || !container.contains(e.target as Node)) return
      const focusable = Array.from(container.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter(el => el.offsetParent !== null || el === document.activeElement)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      // Focus parked on a non-tabbable element (a sheet after a page change) would otherwise Tab out of the modal.
      if (!focusable.includes(document.activeElement as HTMLElement)) {
        e.preventDefault()
        const focusTarget = e.shiftKey ? last : first
        focusTarget.focus()
        return
      }
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
  }, [])

  if (!mounted) return null

  return createPortal(
    <DialogContext.Provider value={{ onOpenChange, titleId, backStack, navStack }}>
      <div 
        ref={dialogRef}
        className="fixed inset-0 z-50 overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        onKeyDownCapture={handleTabCapture}
      >
        <div
          data-theme-part="dialog-overlay"
          className={cn(
            'fixed inset-0 bg-black/50 motion-reduce:transition-none',
            '[transition:opacity_240ms_cubic-bezier(0.22,1,0.36,1)]',
            visible ? 'opacity-100' : 'opacity-0'
          )}
          onClick={(e) => {
            e.stopPropagation()
            onOpenChange?.(false)
          }}
        />
        {React.Children.map(children, child => {
          if (React.isValidElement(child)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return React.cloneElement(child as React.ReactElement<any>, { 'data-state': visible ? 'open' : 'closed' })
          }
          return child
        })}
      </div>
    </DialogContext.Provider>,
    document.body
  )
}

const DialogContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { 'data-state'?: string; hideClose?: boolean }>(
  ({ className, children, hideClose = false, ...props }, ref) => {
    const { onOpenChange, titleId } = React.useContext(DialogContext)
    const state = props['data-state'] || 'open'
    const touchStartY = React.useRef<number | null>(null)
    const dismissEligible = React.useRef(false)
    const sheetRef = React.useRef<HTMLDivElement>(null)
    const [dragOffset, setDragOffset] = React.useState(0)

    // Dismissal yields while any vertical scroller between the finger and the sheet is
    // scrolled. Horizontal rails compute overflow-y auto too, so only boxes that can
    // actually scroll vertically count.
    const scrolledAbove = (target: EventTarget) => {
        const sheet = sheetRef.current
        let node: Element | null = target instanceof Element ? target : null
        while (node) {
            if (node instanceof HTMLElement && node.scrollTop > 0) {
                const overflowY = window.getComputedStyle(node).overflowY
                if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) return true
            }
            if (node === sheet) break
            node = node.parentElement
        }
        return false
    }

    const handleTouchStart = (e: React.TouchEvent) => {
        touchStartY.current = e.touches[0].clientY
        const sheet = sheetRef.current
        if (sheet) {
            const rect = sheet.getBoundingClientRect()
            dismissEligible.current = e.touches[0].clientY - rect.top < rect.height / 2
        }
    }

    const handleTouchMove = (e: React.TouchEvent) => {
        if (touchStartY.current === null) return
        const y = e.touches[0].clientY
        const delta = y - touchStartY.current
        if (Math.abs(delta) < 12) return
        if (!dismissEligible.current) {
            touchStartY.current = null
            return
        }
        // An upward first move or a scrolled container means the finger is scrolling, not dismissing.
        if ((dragOffset === 0 && delta < 0) || scrolledAbove(e.target)) {
            touchStartY.current = null
            setDragOffset(0)
            return
        }
        setDragOffset(Math.max(0, delta))
    }

    const handleTouchEnd = () => {
        const dismiss = dragOffset > 80
        touchStartY.current = null
        if (dismiss) {
            onOpenChange?.(false)
            return
        }
        setDragOffset(0)
    }

    return (
      <div
        data-theme-part="dialog"
        ref={node => {
            sheetRef.current = node
            if (typeof ref === 'function') ref(node)
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
        }}
        aria-labelledby={titleId}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={dragOffset > 0 ? { transform: `translateY(${dragOffset}px)`, transition: 'none' } : undefined}
        className={cn(
          'fixed z-50 grid w-full gap-4 overflow-y-auto overflow-x-hidden',
          // Mobile: bottom sheet anchored to the bottom of the viewport. Opens on the
          // Cider spring curve (slight overshoot); the state flip drives the transform
          // so nothing runs at mount with a stale implicit end state.
          'left-0 right-0 bottom-0 top-auto max-h-[92vh] p-4',
          'rounded-t-2xl rounded-b-none border-t border-[color:var(--chrome-line)]',
          'bg-card shadow-[0_-8px_32px_hsl(0_0%_0%/0.24)]',
          'max-[639px]:transition-transform max-[639px]:duration-[420ms] max-[639px]:ease-[cubic-bezier(0.38,0.8,0.32,1.07)]',
          // Reduced motion removes every transition at both breakpoints; the
          // important marker wins over the responsive transition utilities below.
          'motion-reduce:animate-none motion-reduce:!transition-none',
          // sm and up: centered modal, Cider's entrance curve with a small scale
          'sm:left-[50%] sm:right-auto sm:top-[50%] sm:bottom-auto sm:translate-x-[-50%] sm:translate-y-[-50%]',
          'sm:max-w-lg sm:max-h-[95vh] sm:rounded-2xl sm:border sm:border-[color:var(--chrome-line)]',
          'sm:shadow-[0_24px_64px_hsl(0_0%_0%/0.24)]',
          'sm:p-6',
          'sm:transition-[transform,opacity] sm:duration-[320ms] sm:ease-[cubic-bezier(0.22,1,0.36,1)]',
          state === 'open'
            ? 'opacity-100 max-[639px]:translate-y-0 sm:scale-100'
            : 'opacity-0 max-[639px]:translate-y-full sm:scale-[.96]',
          className
        )}
        {...props}
      >
        <div aria-hidden="true" className="mx-auto mb-1 h-1 w-9 shrink-0 rounded-full bg-border/70 sm:hidden" />
        {children}
        {!hideClose && (
          <button
            data-theme-part="button"
            data-variant="ghost"
            type="button"
            onClick={() => onOpenChange?.(false)}
            aria-label="Close dialog"
            className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full bg-muted/30 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:right-3 sm:top-3 sm:h-8 sm:w-8"
          >
            <X className="h-3.5 w-3.5" />
            <span className="sr-only">Close</span>
          </button>
        )}
      </div>
    )
  }
)
DialogContent.displayName = 'DialogContent'

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-2 text-center sm:text-left min-w-0 pr-10', className)} {...props} />
)
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    // Wrap an overfull footer; otherwise the primary button is the only one that shrinks and its label gets clipped.
    className={cn('flex flex-col-reverse flex-wrap gap-3 pt-2 sm:flex-row sm:items-center sm:justify-end min-w-0 [&_button]:h-11 [&_button]:w-full [&_button]:rounded-full [&_button]:px-5 sm:[&_button]:w-auto', className)}
    {...props}
  />
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => {
    const { titleId } = React.useContext(DialogContext)
    return (<h2
      ref={ref}
      id={titleId}
      className={cn('text-lg font-bold leading-tight tracking-tight min-w-0', className)}
      {...props}
    />)
  }
)
DialogTitle.displayName = 'DialogTitle'

const DialogDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (<div ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />)
)
DialogDescription.displayName = 'DialogDescription'

export { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogBack, DialogAltHistory, useDialogBack, useDrillHistory, useAltArrowHistory }
