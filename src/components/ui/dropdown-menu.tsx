import { cn } from '@/lib/utils'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useDragControls, useReducedMotion } from 'framer-motion'
import { usePhoneViewport } from '@/hooks/usePhoneViewport'
import { destructiveLast, pickMenuPresentation } from '@/lib/menu-presentation'
import { shouldDismissSheet } from '@/lib/touch-gestures'

interface DropdownMenuProps {
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Layout classes for the wrapper div (inline-block by default); full-width rows pass w-full. */
  className?: string
}

interface DropdownMenuContextValue {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  triggerRef: React.MutableRefObject<HTMLElement | null>
  contentId: string
}

const getMenuItems = (menu: HTMLElement | null) =>
  menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')) : []

const DropdownMenuContext = React.createContext<DropdownMenuContextValue | undefined>(undefined)
const MenuSheetContext = React.createContext(false)

const containsMenuItem = (nodes: React.ReactNode): boolean =>
  React.Children.toArray(nodes).some(node => {
    if (!React.isValidElement(node)) return false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const element = node as React.ReactElement<any>
    return element.type === DropdownMenuItem || containsMenuItem(element.props.children)
  })

const orderSheetChildren = (nodes: React.ReactNode): React.ReactNode[] =>
  destructiveLast(React.Children.toArray(nodes), node =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    React.isValidElement(node) && node.type === DropdownMenuItem && Boolean((node.props as any).destructive))

const DropdownMenu = ({ children, open: controlledOpen, onOpenChange, className }: DropdownMenuProps) => {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const isControlled = controlledOpen !== undefined
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const contentId = React.useId()
  const open = isControlled ? controlledOpen : uncontrolledOpen

  const setOpen = React.useCallback((value: React.SetStateAction<boolean>) => {
    const newValue = typeof value === 'function' ? value(open) : value
    if (!isControlled) {
      setUncontrolledOpen(newValue)
    }
    onOpenChange?.(newValue)
  }, [isControlled, open, onOpenChange])

  React.useEffect(() => {
    if (!isControlled) {
      onOpenChange?.(open)
    }
  }, [open, isControlled, onOpenChange])

  return (
    <DropdownMenuContext.Provider value={{ open, setOpen, triggerRef, contentId }}>
      <div className={cn('relative inline-block', className)}>{children}</div>
    </DropdownMenuContext.Provider>
  )
}

interface DropdownMenuTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean
}

const DropdownMenuTrigger = React.forwardRef<HTMLButtonElement, DropdownMenuTriggerProps>(
  ({ className, children, asChild, ...props }, ref) => {
    const context = React.useContext(DropdownMenuContext)
    if (!context) throw new Error('DropdownMenuTrigger must be used within DropdownMenu')

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      context.setOpen(!context.open)
      if (props.onClick) {
        props.onClick(e)
      }
    }

    const setRefs = (node: HTMLButtonElement | null) => {
      context.triggerRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    }

    const aria = {
      'aria-haspopup': 'menu' as const,
      'aria-expanded': context.open,
      'aria-controls': context.open ? context.contentId : undefined,
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
      props.onKeyDown?.(e)
      if (e.defaultPrevented) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        context.setOpen(true)
        const edge = e.key === 'ArrowUp' ? 'last' : 'first'
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const items = getMenuItems(document.getElementById(context.contentId))
          items[edge === 'last' ? items.length - 1 : 0]?.focus()
        }))
      }
    }

    if (asChild && React.isValidElement(children)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const child = children as React.ReactElement<any>
      return React.cloneElement(child, {
        'data-theme-part': child.props['data-theme-part'] ?? 'button',
        className: cn(child.props.className, className),
        ref: setRefs,
        ...aria,
        onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
          handleClick(e)
          if (child.props.onClick) {
            child.props.onClick(e)
          }
        },
        ...props,
        onKeyDown: handleKeyDown,
      })
    }

    return (
      <button
        data-theme-part="button"
        ref={setRefs}
        type="button"
        className={cn('inline-flex items-center justify-center', className)}
        onClick={handleClick}
        {...aria}
        {...props}
        onKeyDown={handleKeyDown}
      >
        {children}
      </button>
    )
  }
)
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger'

interface DropdownMenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  collisionPadding?: number
  sheetHeader?: React.ReactNode
}

// Outer gate: lists render one menu per card, so the content stays unmounted
// (no viewport/motion subscriptions, no children walk, no timers) until the
// menu opens. On close the body signals when its exit finished (desktop after
// the 150ms fade, the phone sheet from AnimatePresence onExitComplete), and a
// safety timer guards against a missed signal.
const DropdownMenuContent = React.forwardRef<HTMLDivElement, DropdownMenuContentProps>(
  (props, ref) => {
    const context = React.useContext(DropdownMenuContext)
    if (!context) throw new Error('DropdownMenuContent must be used within DropdownMenu')

    const [mounted, setMounted] = React.useState(context.open)
    const release = React.useCallback(() => setMounted(false), [])

    React.useEffect(() => {
      if (context.open) {
        setMounted(true)
        return
      }
      const safety = setTimeout(release, 800)
      return () => clearTimeout(safety)
    }, [context.open, release])

    if (!mounted) return null
    return <DropdownMenuContentBody {...props} ref={ref} onExited={release} />
  }
)
DropdownMenuContent.displayName = 'DropdownMenuContent'

const DropdownMenuContentBody = React.forwardRef<HTMLDivElement, DropdownMenuContentProps & { onExited?: () => void }>(
  ({ className, align = 'end', sideOffset, collisionPadding: _collisionPadding, sheetHeader, children, onKeyDown, onExited, ...props }, _ref) => {
    const context = React.useContext(DropdownMenuContext)
    if (!context) throw new Error('DropdownMenuContent must be used within DropdownMenu')

    const menuRef = React.useRef<HTMLDivElement>(null)
    const phone = usePhoneViewport()
    const reduceMotion = useReducedMotion()
    const dragControls = useDragControls()
    const sheet = pickMenuPresentation(phone, containsMenuItem(children)) === 'sheet'
    const [visible, setVisible] = React.useState(false)

    React.useEffect(() => {
      if (context.open) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setVisible(true))
        })
        return
      }
      setVisible(false)
      // Desktop menus transition out over 240ms; the phone sheet's spring exit is
      // longer and is released by AnimatePresence's onExitComplete instead.
      if (!sheet) {
        const timer = setTimeout(() => onExited?.(), 260)
        return () => clearTimeout(timer)
      }
    }, [context.open, sheet, onExited])

    React.useEffect(() => {
      if (!sheet || !context.open) return
      const frame = requestAnimationFrame(() => menuRef.current?.focus({ preventScroll: true }))
      return () => cancelAnimationFrame(frame)
    }, [sheet, context.open])

    const dismissSheet = () => {
      context.setOpen(false)
      context.triggerRef.current?.focus()
    }

    React.useEffect(() => {
      if (sheet) return
      const handleClickOutside = (event: MouseEvent) => {
        if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
          const parent = menuRef.current.parentElement
          if (parent && !parent.contains(event.target as Node)) {
            context.setOpen(false)
          } else {
            setTimeout(() => context.setOpen(false), 0)
          }
        }
      }

      if (context.open) {
        document.addEventListener('mousedown', handleClickOutside)
      }
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [context.open, context, sheet])

    React.useEffect(() => {
      if (!context.open) return
      // Capture phase plus preventDefault: a menu inside a dialog consumes its Escape before the dialog sees it.
      const handleEscape = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        context.setOpen(false)
        context.triggerRef.current?.focus()
      }
      document.addEventListener('keydown', handleEscape, true)
      return () => document.removeEventListener('keydown', handleEscape, true)
    }, [context.open, context])

    const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event)
      if (event.defaultPrevented) return
      const items = getMenuItems(menuRef.current)
      if (items.length === 0) return
      const index = items.indexOf(document.activeElement as HTMLElement)
      let next = -1
      if (event.key === 'ArrowDown') next = (index + 1) % items.length
      else if (event.key === 'ArrowUp') next = index <= 0 ? items.length - 1 : index - 1
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = items.length - 1
      else if (event.key === 'Tab') {
        context.setOpen(false)
        return
      }
      if (next < 0) return
      event.preventDefault()
      items[next].focus()
    }

    if (sheet) {
      return createPortal(
        <AnimatePresence onExitComplete={onExited}>
          {context.open && (
            <div
              className="fixed inset-0 z-[70]"
              onClick={e => e.stopPropagation()}
              onMouseDown={e => e.stopPropagation()}
              onTouchStart={e => e.stopPropagation()}
            >
              <motion.div
                className="absolute inset-0 touch-none bg-black/50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.15 }}
                onClick={dismissSheet}
              />
              <motion.div
                data-theme-part="menu-sheet"
                className="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-border/40 bg-card pb-[calc(env(safe-area-inset-bottom,0px)+12px)] text-card-foreground shadow-[0_-8px_32px_hsl(0_0%_0%/0.32)]"
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.42, ease: [0.38, 0.8, 0.32, 1.07] }}
                drag="y"
                dragControls={dragControls}
                dragListener={false}
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0, bottom: 0.4 }}
                onDragEnd={(_, info) => { if (shouldDismissSheet(info.offset.y, info.velocity.y)) dismissSheet() }}
              >
                <div
                  className="flex h-8 touch-none cursor-grab justify-center pt-2.5"
                  aria-hidden="true"
                  onPointerDown={e => dragControls.start(e)}
                >
                  <span className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
                </div>
                {sheetHeader && (
                  <div data-theme-part="menu-sheet-header" className="mx-3 mb-2 flex min-w-0 items-center gap-3 px-1">
                    {sheetHeader}
                  </div>
                )}
                <div
                  ref={menuRef}
                  id={context.contentId}
                  role="menu"
                  aria-orientation="vertical"
                  aria-label="Menu"
                  tabIndex={-1}
                  data-theme-part="menu"
                  data-state="open"
                  className="mx-3 max-h-[60dvh] overflow-y-auto overscroll-contain rounded-2xl border border-border/40 bg-muted/20 outline-none"
                  {...props}
                  onKeyDown={handleMenuKeyDown}
                >
                  <MenuSheetContext.Provider value>{orderSheetChildren(children)}</MenuSheetContext.Provider>
                </div>
                <button
                  type="button"
                  onClick={dismissSheet}
                  className="mx-3 mt-2 flex min-h-[52px] w-[calc(100%-1.5rem)] items-center justify-center rounded-2xl border border-border/40 bg-muted/30 text-sm font-semibold"
                >
                  Cancel
                </button>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )
    }

    return (
      <div
        ref={menuRef}
        id={context.contentId}
        role="menu"
        data-theme-part="menu"
        data-state={context.open ? 'open' : 'closed'}
        style={{
          marginTop: sideOffset ? `${sideOffset}px` : undefined,
          willChange: 'transform, opacity',
        }}
        className={cn(
          'absolute z-50 min-w-[8rem] overflow-hidden rounded-2xl border border-border/40 bg-card p-1 text-card-foreground shadow-lg',
          // Cider's open spring: transform overshoots slightly, opacity rides the entrance curve.
          '[transition:transform_240ms_cubic-bezier(0.38,0.8,0.32,1.07),opacity_240ms_cubic-bezier(0.22,1,0.36,1),box-shadow_150ms_ease-out]',
          'motion-reduce:transition-none',
          'origin-top',
          visible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 -translate-y-1',
          !context.open && 'pointer-events-none',
          align === 'end' && 'right-0',
          align === 'start' && 'left-0',
          align === 'center' && 'left-1/2 -translate-x-1/2',
          'top-full mt-1',
          className
        )}
        {...props}
        onKeyDown={handleMenuKeyDown}
      >
        {children}
      </div>
    )
  }
)
DropdownMenuContentBody.displayName = 'DropdownMenuContentBody'

interface DropdownMenuItemProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  destructive?: boolean
  /** Keep the menu open after the click, for items that show their own progress. */
  keepOpen?: boolean
  /** Not a Radix menu: onSelect would bind the DOM text-selection event and never run. Use onClick. */
  onSelect?: never
}

const DropdownMenuItem = React.forwardRef<HTMLButtonElement, DropdownMenuItemProps>(
  ({ className, destructive, keepOpen, children, onClick, ...props }, ref) => {
    const context = React.useContext(DropdownMenuContext)
    const inSheet = React.useContext(MenuSheetContext)

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      if (!keepOpen) context?.setOpen(false)
      onClick?.(e)
    }

    return (
      <button
        ref={ref}
        type="button"
        role="menuitem"
        data-theme-part="menu-item"
        data-variant={destructive ? 'destructive' : 'default'}
        className={cn(
          'relative flex w-full cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none transition-colors',
          'hover:bg-muted/50 hover:text-foreground focus:bg-muted/50 focus:text-foreground',
          destructive &&
          'text-destructive hover:text-destructive hover:bg-destructive/10',
          className,
          inSheet && 'min-h-[52px] gap-3 rounded-none px-4 py-3 text-base font-medium active:bg-muted/50 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/30'
        )}
        onClick={handleClick}
        {...props}
      >
        {children}
      </button>
    )
  }
)
DropdownMenuItem.displayName = 'DropdownMenuItem'

const DropdownMenuSeparator = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (<div ref={ref} className={cn('-mx-1 my-1 h-px bg-muted', className)} {...props} />)
)
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator'

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
}
