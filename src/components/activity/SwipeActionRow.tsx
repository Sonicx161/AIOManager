import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { usePhoneViewport } from '@/hooks/usePhoneViewport'
import { classifyAxis, clampSwipeOffset, settleSwipe, SWIPE_ACTIONS_WIDTH } from '@/lib/touch-gestures'
import { cn } from '@/lib/utils'

let openRowId: string | null = null
const listeners = new Set<() => void>()
const setOpenRow = (id: string | null) => {
  if (openRowId === id) return
  openRowId = id
  listeners.forEach(notify => notify())
}
const subscribeOpenRow = (notify: () => void) => {
  listeners.add(notify)
  return () => { listeners.delete(notify) }
}
const getOpenRow = () => openRowId

interface SwipeActionRowProps {
  id: string
  onDelete?: () => void
  disabled?: boolean
  children: ReactNode
}

export function SwipeActionRow({ id, onDelete, disabled, children }: SwipeActionRowProps) {
  const phone = usePhoneViewport()
  const active = phone && !disabled && Boolean(onDelete)
  const open = useSyncExternalStore(subscribeOpenRow, getOpenRow) === id
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; t: number; startOpen: boolean; axis: ReturnType<typeof classifyAxis>; pointerId: number; lastX: number; lastT: number; vx: number } | null>(null)
  const suppressClick = useRef(false)
  const width = SWIPE_ACTIONS_WIDTH / 2

  useEffect(() => {
    if (!dragging) setOffset(open ? -width : 0)
  }, [open, dragging, width])

  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    if (offset !== 0) { setMounted(true); return }
    const timer = window.setTimeout(() => setMounted(false), 250)
    return () => window.clearTimeout(timer)
  }, [offset])

  useEffect(() => {
    if (!open) return
    const onOutside = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenRow(null)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenRow(null) }
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('keydown', onKey)
      if (openRowId === id) setOpenRow(null)
    }
  }, [open, id])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!active || event.pointerType === 'mouse' || !event.isPrimary) return
    drag.current = {
      x: event.clientX, y: event.clientY, t: event.timeStamp, startOpen: open,
      axis: 'pending', pointerId: event.pointerId, lastX: event.clientX, lastT: event.timeStamp, vx: 0,
    }
    suppressClick.current = false
  }, [active, open])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    const dx = event.clientX - state.x
    if (state.axis === 'pending') {
      state.axis = classifyAxis(dx, event.clientY - state.y)
      if (state.axis === 'vertical') { drag.current = null; return }
      if (state.axis === 'horizontal') {
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
      }
    }
    if (state.axis !== 'horizontal') return
    const dt = event.timeStamp - state.lastT
    if (dt > 0) state.vx = (event.clientX - state.lastX) / dt
    state.lastX = event.clientX
    state.lastT = event.timeStamp
    suppressClick.current = true
    setOffset(clampSwipeOffset(state.startOpen, dx, width))
  }, [width])

  const finish = useCallback((event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    drag.current = null
    if (state.axis !== 'horizontal') return
    setDragging(false)
    const dx = event.clientX - state.x
    const shouldOpen = cancelled ? state.startOpen : settleSwipe(state.startOpen, dx, state.vx, width)
    setOpenRow(shouldOpen ? id : null)
    setOffset(shouldOpen ? -width : 0)
    window.setTimeout(() => { suppressClick.current = false }, 0)
  }, [id, width])

  const onClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (open && !(event.target as Element).closest('[data-swipe-actions]')) {
      event.preventDefault()
      event.stopPropagation()
      setOpenRow(null)
    }
  }, [open])

  if (!active) return <>{children}</>

  const revealed = Math.abs(offset)
  return (
    <div
      ref={rootRef}
      data-swipe-row
      className={cn('relative rounded-2xl', (mounted || revealed > 0) && 'overflow-hidden')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={e => finish(e, false)}
      onPointerCancel={e => finish(e, true)}
      onClickCapture={onClickCapture}
      style={{ touchAction: 'pan-y' }}
    >
      {(mounted || revealed > 0) && (
        <div
          data-swipe-actions
          aria-hidden={!open}
          className={cn('absolute inset-y-0 right-0 overflow-hidden', !dragging && 'motion-safe:transition-[width] motion-safe:duration-200')}
          style={{ width: revealed }}
        >
          <div className="ml-auto flex h-full gap-1.5 py-0.5 pl-1.5" style={{ width }}>
            {onDelete && (
              <button
                type="button"
                tabIndex={open ? 0 : -1}
                onClick={() => { setOpenRow(null); onDelete() }}
                className="flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl bg-destructive text-xs font-semibold text-destructive-foreground"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            )}
          </div>
        </div>
      )}
      <div
        className={cn('relative', !dragging && 'motion-safe:transition-transform motion-safe:duration-200')}
        style={{ transform: offset ? `translateX(${offset}px)` : undefined }}
      >
        {children}
      </div>
    </div>
  )
}
