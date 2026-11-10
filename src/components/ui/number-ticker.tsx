'use client'

import { useEffect, useRef, useMemo } from 'react'
import { useInView, useMotionValue, useReducedMotion, useSpring } from 'framer-motion'
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
  // A physics spring only rests within 0.5 of its target, so large values creep for seconds.
  const springValue = useSpring(motionValue, prefersReducedMotion
    ? { duration: 0.01, bounce: 0 }
    : { duration: 1, bounce: 0 })
  const isInView = useInView(ref, { once: true, margin: '0px' })
  const formatter = useMemo(() => Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }), [decimalPlaces])

  useEffect(() => {
    if (isInView) {
      const timer = setTimeout(() => {
        motionValue.set(direction === 'down' ? startValue : value)
      }, delay * 1000)
      return () => clearTimeout(timer)
    }
  }, [motionValue, isInView, delay, value, direction, startValue])

  useEffect(() => {
    const update = (latest: number) => {
      if (ref.current) {
        const text = formatter.format(Number(latest.toFixed(decimalPlaces)))
        if (ref.current.textContent !== text) ref.current.textContent = text
      }
    }
    update(springValue.get())
    return springValue.on('change', update)
  }, [springValue, decimalPlaces, formatter])

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
