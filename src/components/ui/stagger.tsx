import { useEffect, useRef, useState, createContext, useContext } from 'react'
import { cn } from '@/lib/utils'

// Rows beyond this band start visible so a fast scroll never reaches a dim row.
const REVEAL_MARGIN_PX = 800

interface StaggerContainerProps {
  children: React.ReactNode
  className?: string
  staggerDelay?: number
}

const StaggerContext = createContext<{ delay: number, nextIndex: () => number }>({
  delay: 0.02,
  nextIndex: () => 0,
})

let appBootSettled = false
setTimeout(() => { appBootSettled = true }, 1500)

function StaggerContainer({
  children,
  className,
  staggerDelay = 0.02,
}: StaggerContainerProps) {
  const counterRef = useRef(0)
  counterRef.current = 0
  const nextIndex = () => counterRef.current++

  return (
    <StaggerContext.Provider value={{ delay: staggerDelay, nextIndex }}>
      <div className={cn(className)}>
        {children}
      </div>
    </StaggerContext.Provider>
  )
}

function StaggerItem({
  children,
  className,
  'data-theme-part': themePart,
}: {
  children: React.ReactNode
  className?: string
  'data-theme-part'?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(() => !appBootSettled)
  const [settled, setSettled] = useState(() => !appBootSettled)
  const { delay, nextIndex } = useContext(StaggerContext)
  const indexRef = useRef<number | null>(null)
  if (indexRef.current === null) {
    indexRef.current = nextIndex()
  }
  const index = indexRef.current
  const cascadeRef = useRef<boolean | undefined>(appBootSettled ? undefined : true)
  const animDelay = cascadeRef.current === false ? 0 : index * delay

  useEffect(() => {
    const el = ref.current
    if (!el) return

    if (!appBootSettled) return

    const rect = el.getBoundingClientRect()
    const inViewport = rect.top < window.innerHeight + REVEAL_MARGIN_PX && rect.bottom > -REVEAL_MARGIN_PX

    if (inViewport) {
      cascadeRef.current = true
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setVisible(true)
        })
      })
      return
    }

    cascadeRef.current = false
    setVisible(true)
  }, [])

  useEffect(() => {
    if (visible) {
      const totalMs = (animDelay + 0.3) * 1000 + 50
      const timer = setTimeout(() => setSettled(true), totalMs)
      return () => clearTimeout(timer)
    }
  }, [visible, animDelay])

  const style = settled ? undefined : visible
    ? { opacity: 1, transform: 'none', transition: `opacity 0.3s ease ${animDelay}s, transform 0.3s ease ${animDelay}s` }
    : { opacity: 0, transform: 'translateY(12px) scale(0.97)', transition: 'none' }

  return (
    <div
      ref={ref}
      data-theme-part={themePart}
      className={cn('h-full', className)}
      style={style}
    >
      {children}
    </div>
  )
}

export { StaggerContainer, StaggerItem }
