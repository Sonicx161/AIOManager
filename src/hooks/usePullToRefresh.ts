import { useEffect, useRef, useState } from 'react'
import { classifyAxis, GESTURE_SLOP, PULL_THRESHOLD, pullDistance, pullPhase, type GestureAxis, type PullPhase } from '@/lib/touch-gestures'

const MIN_REFRESH_MS = 500
const IGNORED = '[role="dialog"],[role="menu"],input,textarea,select,[data-no-pull]'

function findScroller(from: Element | null): Element {
  for (let el = from; el && el !== document.body; el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el
  }
  return document.scrollingElement ?? document.documentElement
}

interface PullToRefreshOptions {
  enabled: boolean
  onRefresh?: () => unknown
}

export function usePullToRefresh({ enabled, onRefresh }: PullToRefreshOptions) {
  const [distance, setDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const onRefreshRef = useRef(onRefresh)
  const refreshingRef = useRef(false)

  useEffect(() => { onRefreshRef.current = onRefresh })

  useEffect(() => {
    if (!enabled) return
    const html = document.documentElement
    const main = document.getElementById('main-content')
    const prevHtml = html.style.overscrollBehaviorY
    const prevMain = main?.style.overscrollBehaviorY ?? ''
    html.style.overscrollBehaviorY = 'contain'
    if (main) main.style.overscrollBehaviorY = 'contain'

    let start: { x: number; y: number; scroller: Element } | null = null
    let axis: GestureAxis = 'pending'
    let engaged = false
    let current = 0

    const reset = () => {
      start = null
      engaged = false
      current = 0
      if (!refreshingRef.current) setDistance(0)
    }

    const onStart = (event: TouchEvent) => {
      start = null
      if (refreshingRef.current || event.touches.length !== 1) return
      const target = event.target as Element | null
      if (!target?.closest || target.closest(IGNORED)) return
      const scroller = findScroller(target)
      if (scroller.scrollTop > 0) return
      const touch = event.touches[0]
      start = { x: touch.clientX, y: touch.clientY, scroller }
      axis = 'pending'
      engaged = false
      current = 0
    }

    const onMove = (event: TouchEvent) => {
      if (!start || event.touches.length !== 1) return
      const touch = event.touches[0]
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      if (axis === 'pending') {
        axis = classifyAxis(dx, dy)
        if (axis === 'pending') return
        if (axis === 'horizontal' || dy < 0) { start = null; return }
      }
      if (start.scroller.scrollTop > 0) {
        if (engaged) reset()
        else start = null
        return
      }
      if (dy <= GESTURE_SLOP && !engaged) return
      if (event.cancelable) event.preventDefault()
      engaged = true
      current = pullDistance(dy - GESTURE_SLOP)
      setDistance(current)
    }

    const onEnd = () => {
      if (!engaged) { start = null; return }
      if (pullPhase(current) !== 'ready') { reset(); return }
      start = null
      engaged = false
      refreshingRef.current = true
      setRefreshing(true)
      setDistance(PULL_THRESHOLD)
      const startedAt = Date.now()
      Promise.resolve()
        .then(() => onRefreshRef.current?.())
        .catch(() => undefined)
        .then(() => new Promise(resolve => setTimeout(resolve, Math.max(0, MIN_REFRESH_MS - (Date.now() - startedAt)))))
        .finally(() => {
          refreshingRef.current = false
          setRefreshing(false)
          setDistance(0)
        })
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', reset, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', reset)
      html.style.overscrollBehaviorY = prevHtml
      if (main) main.style.overscrollBehaviorY = prevMain
      setDistance(0)
    }
  }, [enabled])

  const phase: PullPhase = refreshing ? 'ready' : pullPhase(distance)
  return { distance, phase, refreshing }
}
