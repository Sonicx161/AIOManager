'use client'

import { useEffect, useRef, useMemo } from 'react'
import { animate, useInView, useMotionValue, useReducedMotion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface NumberTickerProps {
  value: number
  startValue?: number
  direction?: 'up' | 'down'
  delay?: number
  decimalPlaces?: number
  className?: string
}

export function NumberTicker({
  value,
  startValue = 0,
  direction = 'up',
  delay = 0,
  decimalPlaces = 0,
  className,
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const prefersReducedMotion = useReducedMotion()
  const initialValue = useMemo(() => direction === 'down' ? value : startValue, []) // eslint-disable-line react-hooks/exhaustive-deps
  const motionValue = useMotionValue(initialValue)
  const isInView = useInView(ref, { once: true, margin: '0px' })
  const formatter = useMemo(() => Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }), [decimalPlaces])

  useEffect(() => {
    if (!isInView) return
    const controls = animate(motionValue, direction === 'down' ? startValue : value, {
      delay: delay * 1000,
      duration: prefersReducedMotion ? 0 : 1,
      ease: 'easeOut',
    })
    return () => controls.stop()
  }, [motionValue, isInView, delay, value, direction, startValue, prefersReducedMotion])

  useEffect(() => {
    const update = (latest: number) => {
      if (ref.current) {
        const text = formatter.format(Number(latest.toFixed(decimalPlaces)))
        if (ref.current.textContent !== text) ref.current.textContent = text
      }
    }
    update(motionValue.get())
    return motionValue.on('change', update)
  }, [motionValue, decimalPlaces, formatter])

  return (
    <span
      className={cn(
        'inline-block tabular-nums',
        className,
      )}
      ref={ref}
    >
      {formatter.format(initialValue)}
    </span>
  )
}

// Ticks on first reveal only; later changes render the settled number outright.
export function StatNumber({ value, animate: tick }: { value: number; animate: boolean }) {
  return tick ? <NumberTicker value={value} /> : <>{value.toLocaleString()}</>
}
