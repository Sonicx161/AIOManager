import { useRef } from 'react'
import { useOffscreenGate } from '@/hooks/use-offscreen-gate'

// Passthrough box that holds its skip class only while it sits outside the viewport.
export function OffscreenGate({ className, children }: { className: string; children: React.ReactNode }) {
    const ref = useRef<HTMLDivElement>(null)
    const skipClass = useOffscreenGate(ref, className)
    return <div ref={ref} className={skipClass}>{children}</div>
}
